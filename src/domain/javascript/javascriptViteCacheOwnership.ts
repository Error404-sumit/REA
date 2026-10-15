import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronMemberPath,
} from "./javascriptElectronMemberWrites.js";
import {
  indexViteContainerIdentitiesSteps,
  type ViteContainerIdentities,
} from "./javascriptViteContainerIdentities.js";
import { createViteCacheReadProofSteps } from "./javascriptViteCacheReads.js";
import { traverseJavaScriptAstSteps } from "./javascriptSemanticTraversal.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import {
  semanticArrayIndex,
  semanticPropertyPathKeyMatches,
} from "./javascriptSemanticPropertyPaths.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";

type CacheTable = readonly (string | undefined)[];
type CacheKey = string | null | undefined;
type CachePath = readonly (string | null)[];
type AliasInitializer =
  JavaScriptSemanticBindingState["referenceInitializers"][number];
type AliasVertex = string | t.Node;
const ESCAPED_CONTAINER = ":vite:unresolved-container";

interface ViteCacheOrigins {
  readonly resolve: (node: t.Node, escape?: boolean) => readonly CachePath[];
  readonly escaped: readonly CachePath[];
}

interface CacheOwnership {
  /** null joins different helper owners without allocating their cross-product. */
  readonly owner: string | null;
  readonly first: CacheKey;
  readonly direct: boolean;
  readonly shared: boolean;
  /** Shared contents belong to this container slot, independently of owner identity. */
  readonly child: CacheKey;
}

interface CacheAlias {
  readonly target: AliasVertex;
  /** Selection in the source before an object-rest copy. */
  readonly sourceFirst?: CacheKey;
  /** Selection in the produced value, after any copy. */
  readonly first: CacheKey;
  /** undefined is an alias; a boolean retains the object-rest copied selection. */
  readonly copyKeepsCache?: boolean;
  readonly read?: t.Node;
  /** A newly allocated container shares this value, but is not the value itself. */
  readonly container?: boolean;
  readonly containerKey?: CacheKey;
  readonly copyExcludedKeys?: readonly string[];
  readonly copyStartIndex?: number;
}

interface CacheAliasInput extends Pick<CacheAlias, "first" | "copyKeepsCache"> {
  readonly source: AliasVertex;
}

/** invalidate admitted Vite caches through possible lexical aliases and shared writes. */
export function* invalidateJavaScriptViteCachesSteps(
  program: t.Program,
  tables: Map<string, CacheTable | null>,
  initializations: ReadonlySet<t.Node | undefined>,
  state: JavaScriptSemanticAnalysisState,
): Generator<void> {
  const { resolve: origins, escaped } = yield* createViteCacheOriginsSteps(
    tables,
    state,
  );
  const interop = createSemanticModuleInterop(state);
  const reads = yield* createViteCacheReadProofSteps(tables, state);
  const calls: {
    node: t.Node;
    receiver: t.Node;
    method: string | null;
    arguments: readonly t.CallExpression["arguments"][number][] | undefined;
    paths: readonly CachePath[];
  }[] = [];
  let allOwners = false;
  const retain = (node: t.Node, path: CachePath): void => {
    const owner = path[0];
    if (initializations.has(node) || owner === undefined || allOwners) return;
    reads.recordWrite(path);
    if (path.length !== 1 && path[1] !== null && path[1] !== "f") return;
    const slot = path[2];
    if (
      slot !== undefined &&
      slot !== null &&
      slot !== "length" &&
      semanticArrayIndex(slot) === null
    )
      return;
    if (owner === null) allOwners = true;
    else if (tables.has(owner)) tables.set(owner, null);
  };
  for (const path of escaped) retain(program, path);
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    (node, kind) => (kind === "member" ? origins(node) : []),
    (node) => {
      const callee = unwrapJavaScriptExpression(node.callee).node;
      if (
        t.isMemberExpression(callee) ||
        t.isOptionalMemberExpression(callee)
      ) {
        const method = semanticStaticPropertyKey(
          callee.property,
          callee.computed,
        );
        const paths = origins(callee.object, true);
        if (paths.length > 0)
          calls.push({
            node,
            receiver: callee.object,
            method,
            arguments: node.arguments,
            paths,
          });
      }
      const invocation = interop.intrinsicInvocation(node);
      if (
        invocation?.path.slice(0, -1).join(".") ===
          "intrinsic.Array.prototype" &&
        invocation.receiver !== undefined
      ) {
        const paths = origins(invocation.receiver, true);
        if (paths.length > 0)
          calls.push({
            node,
            receiver: invocation.receiver,
            method:
              invocation.kind === "known"
                ? (invocation.path.at(-1) ?? null)
                : null,
            arguments: invocation.arguments,
            paths,
          });
      }
      // Ordinary calls can mutate any cache value passed to them. Intrinsic
      // producers and known array reads retain their own ownership semantics.
      const intrinsicMethod = invocation?.path.at(-1);
      const knownObjectOperation =
        invocation?.kind === "known" &&
        invocation.path[1] === "Object" &&
        [
          "assign",
          "create",
          "defineProperty",
          "defineProperties",
          "setPrototypeOf",
        ].includes(intrinsicMethod ?? "");
      if (!knownObjectOperation)
        for (const argument of invocation?.arguments ?? node.arguments)
          for (const path of origins(
            t.isSpreadElement(argument) ? argument.argument : argument,
            true,
          ))
            retain(node, path);
      return invocation;
    },
    interop.staticString,
    interop.isFreshObject,
    retain,
  );
  // Defer read proofs until every visible write to an own method is indexed.
  for (const call of calls) {
    yield;
    if (
      call.arguments === undefined ||
      !reads.isRead(call.receiver, call.method, call.arguments, call.paths)
    )
      for (const path of call.paths) retain(call.node, path);
  }
  if (allOwners) {
    let examined = 0;
    for (const owner of tables.keys()) {
      if (examined++ % 1024 === 0) yield;
      tables.set(owner, null);
    }
  }
}

function* createViteCacheOriginsSteps(
  tables: ReadonlyMap<string, CacheTable | null>,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, ViteCacheOrigins> {
  const detachments = yield* indexViteCacheDetachmentsSteps(state);
  const aliases = yield* indexViteAliasesSteps(state, detachments.identities);
  const facts = new Map<AliasVertex, CacheOwnership>();
  const helperIdentities = new Map<string, string>();
  const pending: { binding: AliasVertex; ownership: CacheOwnership }[] = [];
  // each binding has one owner or an ambiguous marker. each field can widen
  // only once, so retained facts and queued updates stay proportional to source.
  const retain = (binding: AliasVertex, incoming: CacheOwnership): void => {
    const previous = facts.get(binding);
    const ownership = joinOwnership(previous, incoming);
    if (ownership === previous) return;
    facts.set(binding, ownership);
    pending.push({ binding, ownership });
  };
  for (const owner of tables.keys()) {
    helperIdentities.set(
      detachments.identities.roots.get(owner) ?? owner,
      owner,
    );
    retain(owner, {
      owner,
      first: undefined,
      direct: true,
      shared: true,
      child: undefined,
    });
  }
  let examinedAliases = 0;
  for (let cursor = 0; cursor < pending.length; cursor++) {
    if (cursor % 1024 === 0) yield;
    const fact = pending[cursor];
    if (fact === undefined) break;
    for (const alias of aliases.get(fact.binding) ?? []) {
      if (examinedAliases++ % 1024 === 0) yield;
      const source = selectOwnership(fact.ownership, alias.sourceFirst);
      if (source === undefined) continue;
      if (
        typeof fact.binding === "string" &&
        typeof alias.first === "string" &&
        !source.direct &&
        alias.read !== undefined &&
        detachedCacheAt(
          fact.binding,
          alias.first,
          alias.read,
          detachments,
          state,
        )
      )
        continue;
      const copied = alias.container
        ? {
            ...source,
            first: source.first === undefined ? null : source.first,
            direct: false,
            child: alias.containerKey ?? null,
          }
        : alias.copyKeepsCache === undefined
          ? source
          : copyOwnership(source, alias);
      const selected = selectOwnership(copied, alias.first);
      if (selected !== undefined) retain(alias.target, selected);
    }
  }
  const cached = new WeakMap<t.Node, readonly CachePath[]>();
  const resolve = (node: t.Node, escape = false): readonly CachePath[] => {
    const previous = escape ? undefined : cached.get(node);
    if (previous !== undefined) return previous;
    let ownership: CacheOwnership | undefined;
    for (const [source, suffix] of viteAliasSources(
      node,
      state,
      facts,
      detachments,
    ))
      if (facts.has(source)) {
        const fact = facts.get(source);
        if (
          typeof suffix === "string" &&
          fact !== undefined &&
          !fact.direct &&
          typeof source === "string" &&
          detachedCacheAt(source, suffix, node, detachments, state)
        )
          continue;
        const selected = selectOwnership(facts.get(source), suffix);
        if (selected !== undefined)
          ownership = joinOwnership(ownership, selected);
      }
    const paths: readonly CachePath[] =
      ownership?.direct || (escape && ownership?.shared)
        ? [
            ownership.first === undefined
              ? escape && !ownership.direct
                ? [ownership.owner, "f"]
                : [ownership.owner]
              : [ownership.owner, ownership.first],
          ]
        : [];
    // Introduced contents can widen, but cannot replace a proven helper's
    // own object identity. Writes to that helper's f still invalidate it.
    const expression = unwrapJavaScriptExpression(node).node;
    const binding = t.isIdentifier(expression)
      ? resolveSemanticBindingState(state, expression, expression.name)
      : undefined;
    const helper =
      binding === undefined
        ? undefined
        : helperIdentities.get(
            detachments.identities.roots.get(binding.bindingId) ??
              binding.bindingId,
          );
    const result = helper === undefined ? paths : [[helper], ...paths];
    if (!escape) cached.set(node, result);
    return result;
  };
  const escaped = facts.get(ESCAPED_CONTAINER);
  return {
    resolve,
    escaped:
      escaped === undefined ? [] : [[escaped.owner, escaped.first ?? null]],
  };
}

function* indexViteAliasesSteps(
  state: JavaScriptSemanticAnalysisState,
  identities: ViteContainerIdentities,
): Generator<void, ReadonlyMap<AliasVertex, readonly CacheAlias[]>> {
  const aliases = new Map<AliasVertex, CacheAlias[]>();
  const producers: t.Node[] = [];
  const spreadFacts = new WeakMap<t.Node, SpreadCacheFact>();
  const literalSlots = new WeakMap<t.Node, CacheLiteralSlots>();
  const freshFacts = new WeakMap<t.Node, boolean>();
  const interop = createSemanticModuleInterop(state);
  const enqueued = new WeakSet<t.Node>();
  const normalize = (node: t.Node): void => {
    if (enqueued.has(node)) return;
    enqueued.add(node);
    producers.push(node);
  };
  const connect = (source: AliasVertex, alias: CacheAlias): void => {
    const targets = aliases.get(source) ?? [];
    targets.push(alias);
    aliases.set(source, targets);
  };
  const introduce = (
    value: t.Node,
    target: t.Node,
    key: CacheKey,
    sourceFirst?: CacheKey,
  ): void => {
    normalize(value);
    const { root, members } = electronMemberPath(target);
    const binding = t.isIdentifier(root)
      ? resolveSemanticBindingState(state, root, root.name)
      : undefined;
    const identity =
      binding === undefined
        ? undefined
        : identities.roots.get(binding.bindingId);
    const destination =
      identity === undefined
        ? (binding?.bindingId ?? target)
        : `${identity}:vite-assigned-container`;
    const freshTarget =
      t.isObjectExpression(target) ||
      t.isArrayExpression(target) ||
      t.isFunction(target);
    if (
      (binding === undefined && !freshTarget) ||
      (binding !== undefined &&
        (identity === undefined || identities.unresolved.has(identity)))
    )
      connect(value, { target: ESCAPED_CONTAINER, first: null, sourceFirst });
    if (binding === undefined) normalize(target);
    connect(value, {
      target: destination,
      first: undefined,
      container: true,
      containerKey: members.length === 0 ? key : members[0],
      sourceFirst,
    });
    if (
      binding !== undefined &&
      members.length === 0 &&
      typeof key === "string"
    )
      connect(value, {
        target: viteCacheMemberVertex(binding.bindingId, key, identities),
        first: undefined,
        sourceFirst,
      });
  };
  // A discarded assignment still changes every definite alias of its target.
  // Share one vertex per identity instead of expanding each call over aliases.
  for (const [binding, root] of identities.roots) {
    yield;
    connect(`${root}:vite-assigned-container`, {
      target: binding,
      first: undefined,
    });
  }
  let examined = 0;
  for (const binding of state.bindingsById.values()) {
    if (examined++ % 1024 === 0) yield;
    const initializers: readonly AliasInitializer[] = [
      ...binding.initializers,
      ...binding.referenceInitializers,
    ];
    for (const initializer of initializers) {
      const copied = initializer.copyKind !== undefined;
      const projection =
        copied && initializer.copyProjectionOffset !== undefined
          ? initializer.projection.slice(0, initializer.copyProjectionOffset)
          : initializer.projection;
      const key = projection[0];
      normalize(initializer.node);
      connect(initializer.node, {
        target: binding.bindingId,
        first: copied
          ? undefined
          : key === undefined
            ? undefined
            : key === null
              ? null
              : String(key),
        ...(copied
          ? {
              sourceFirst:
                key === undefined
                  ? undefined
                  : key === null
                    ? null
                    : String(key),
              copyKeepsCache: semanticPropertyPathKeyMatches(
                {
                  excludedKeys: initializer.copyExcludedKeys ?? [],
                },
                "f",
              ),
              copyExcludedKeys: initializer.copyExcludedKeys ?? [],
              ...(initializer.copyStartIndex === undefined
                ? {}
                : { copyStartIndex: initializer.copyStartIndex }),
            }
          : {}),
      });
      const expression = unwrapJavaScriptExpression(initializer.node).node;
      if (
        initializer.projection.length === 0 &&
        (t.isObjectExpression(expression) || t.isArrayExpression(expression))
      ) {
        const { properties } = yield* cacheLiteralSlotsSteps(
          expression,
          literalSlots,
        );
        for (const [key, value] of properties) {
          if (examined++ % 1024 === 0) yield;
          normalize(value);
          connect(value, {
            target: viteCacheMemberVertex(binding.bindingId, key, identities),
            first: undefined,
          });
          connect(value, {
            target: binding.bindingId,
            first: undefined,
            container: true,
            containerKey: key,
          });
        }
      }
    }
  }
  // Member assignments can introduce sharing after an initially fresh literal.
  yield* traverseJavaScriptAstSteps(state.program, {
    enter: (node) => {
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        for (const argument of node.arguments)
          normalize(t.isSpreadElement(argument) ? argument.argument : argument);
        const invocation = interop.intrinsicInvocation(node);
        const method = invocation?.path.at(-1);
        if (
          invocation?.kind === "known" &&
          invocation.path.length === 3 &&
          (invocation.path[1] === "Object" || invocation.path[1] === "Reflect")
        ) {
          const target = invocation.arguments?.[0];
          const descriptor =
            invocation.arguments?.[method === "defineProperty" ? 2 : 1];
          if (
            target !== undefined &&
            descriptor !== undefined &&
            !t.isSpreadElement(target) &&
            !t.isSpreadElement(descriptor)
          ) {
            if (method === "defineProperty")
              introduce(
                descriptor,
                target,
                interop.staticString(invocation.arguments?.[1]) ?? null,
                "value",
              );
            else if (method === "defineProperties")
              introduce(descriptor, target, null, null);
            else if (method === "create") {
              normalize(node);
              normalize(descriptor);
              connect(descriptor, {
                target: node,
                first: undefined,
                sourceFirst: null,
                container: true,
                containerKey: null,
              });
            }
          }
        }
        if (
          invocation?.kind === "known" &&
          invocation.path.join(".") === "intrinsic.Object.assign"
        ) {
          const target = invocation.arguments?.[0];
          if (target !== undefined && !t.isSpreadElement(target)) {
            const { root, members } = electronMemberPath(target);
            if (t.isIdentifier(root)) {
              const binding = resolveSemanticBindingState(
                state,
                root,
                root.name,
              );
              if (binding !== undefined) {
                normalize(node);
                const destination =
                  identities.roots.get(binding.bindingId) ?? binding.bindingId;
                connect(node, {
                  target: identities.roots.has(binding.bindingId)
                    ? `${destination}:vite-assigned-container`
                    : destination,
                  first: undefined,
                  ...(members.length > 0 ? { container: true } : {}),
                });
                const key = members[0];
                if (members.length === 1 && key != null)
                  connect(node, {
                    target: viteCacheMemberVertex(destination, key, identities),
                    first: undefined,
                  });
              }
            }
          }
        }
      }
      if (
        !t.isAssignmentExpression(node, { operator: "=" }) ||
        !t.isMemberExpression(node.left)
      )
        return;
      const { root, members } = electronMemberPath(node.left);
      if (!t.isIdentifier(root)) return;
      const binding = resolveSemanticBindingState(state, root, root.name);
      if (binding === undefined) return;
      introduce(
        node.right,
        members.length === 1 ? root : node.left.object,
        members.at(-1) ?? null,
      );
    },
  });
  // shared initializer expressions are vertices, rather than duplicating all
  // branch sources for every destructured binding that reads that expression.
  for (let cursor = 0; cursor < producers.length; cursor++) {
    if (cursor % 1024 === 0) yield;
    const node = producers[cursor];
    if (node === undefined) break;
    const expression = unwrapJavaScriptExpression(node).node;
    if (t.isObjectExpression(expression) || t.isArrayExpression(expression)) {
      const slots = yield* cacheLiteralSlotsSteps(expression, literalSlots);
      for (const [key, value] of cacheLiteralEntries(slots)) {
        if (examined++ % 1024 === 0) yield;
        normalize(value);
        connect(value, {
          target: expression,
          first: undefined,
          container: true,
          containerKey: key,
        });
      }
    }
    for (const input of yield* aliasProducerInputsSteps(
      node,
      state,
      spreadFacts,
      freshFacts,
      interop,
    )) {
      if (typeof input.source !== "string") normalize(input.source);
      connect(input.source, {
        target: node,
        first: input.first,
        read: node,
        ...(input.copyKeepsCache === undefined
          ? {}
          : { copyKeepsCache: input.copyKeepsCache }),
      });
    }
  }
  return aliases;
}

interface CacheLiteralSlots {
  readonly properties: ReadonlyMap<string, t.Node>;
  readonly dynamicValues: readonly t.Node[];
}

function* cacheLiteralEntries(
  slots: CacheLiteralSlots,
): Generator<readonly [CacheKey, t.Node]> {
  yield* slots.properties;
  for (const value of slots.dynamicValues) yield [null, value];
}

/** Decode each literal's effective data slots once for member and container views. */
function* cacheLiteralSlotsSteps(
  node: t.ObjectExpression | t.ArrayExpression,
  cache: WeakMap<t.Node, CacheLiteralSlots>,
): Generator<void, CacheLiteralSlots> {
  const previous = cache.get(node);
  if (previous !== undefined) return previous;
  const properties = new Map<string, t.Node>();
  const dynamicValues: t.Node[] = [];
  if (t.isObjectExpression(node)) {
    const seen = new Set<string>();
    for (let index = node.properties.length - 1; index >= 0; index--) {
      if (index % 1024 === 0) yield;
      const property = node.properties[index];
      if (property === undefined || t.isSpreadElement(property)) continue;
      const key = semanticStaticPropertyKey(property.key, property.computed);
      if (key !== null && seen.has(key)) continue;
      if (key !== null) seen.add(key);
      if (!t.isObjectProperty(property)) continue;
      if (key === null) dynamicValues.push(property.value);
      else properties.set(key, property.value);
    }
  } else {
    let exactIndex = true;
    for (let index = 0; index < node.elements.length; index++) {
      if (index % 1024 === 0) yield;
      const element = node.elements[index];
      if (element == null) continue;
      if (t.isSpreadElement(element)) {
        exactIndex = false;
        dynamicValues.push(element.argument);
      } else if (exactIndex) properties.set(String(index), element);
      else dynamicValues.push(element);
    }
  }
  const result = { properties, dynamicValues };
  cache.set(node, result);
  return result;
}

function* aliasProducerInputsSteps(
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  spreadFacts: WeakMap<t.Node, SpreadCacheFact>,
  freshFacts: WeakMap<t.Node, boolean>,
  interop: ReturnType<typeof createSemanticModuleInterop>,
): Generator<void, readonly CacheAliasInput[]> {
  const { root, members } = electronMemberPath(node);
  const first = members[0];
  if (t.isIdentifier(root)) {
    const binding = resolveSemanticBindingState(state, root, root.name);
    return binding === undefined ? [] : [{ source: binding.bindingId, first }];
  }
  if (t.isObjectExpression(root)) {
    const inputs: CacheAliasInput[] = [];
    let overwritten = false;
    let examined = 0;
    for (let index = root.properties.length - 1; index >= 0; index--) {
      if (examined++ % 1024 === 0) yield;
      const property = root.properties[index];
      if (property === undefined) continue;
      if (t.isSpreadElement(property)) {
        inputs.push({
          source: property.argument,
          first,
          copyKeepsCache: !overwritten,
        });
        if (
          (yield* spreadCacheFactSteps(
            property.argument,
            spreadFacts,
            freshFacts,
            state,
          )) === "fresh"
        )
          overwritten = true;
      } else {
        const key = semanticStaticPropertyKey(property.key, property.computed);
        if (
          key !== null &&
          (first === undefined
            ? key === "f"
            : first === null || key === first) &&
          t.isObjectProperty(property)
        ) {
          if (
            yield* freshCacheReplacementSteps(property.value, freshFacts, state)
          ) {
            overwritten = true;
          } else if (first !== undefined) {
            // Literal contents already enter the container view above. Only
            // an actual property projection denotes the contained value.
            inputs.push({ source: property.value, first: undefined });
          }
        }
      }
    }
    return inputs;
  }
  const invocation = t.isCallExpression(root)
    ? interop.intrinsicInvocation(root)
    : undefined;
  if (
    invocation?.kind === "known" &&
    invocation.path.join(".") === "intrinsic.Object.assign"
  ) {
    const inputs: CacheAliasInput[] = [];
    let overwritten = false;
    let examined = 0;
    const arguments_ = invocation.arguments ?? [];
    for (let index = arguments_.length - 1; index >= 1; index--) {
      if (examined++ % 1024 === 0) yield;
      const source = arguments_[index];
      if (source === undefined || t.isSpreadElement(source)) continue;
      inputs.push({ source, first, copyKeepsCache: !overwritten });
      if (
        (yield* spreadCacheFactSteps(
          source,
          spreadFacts,
          freshFacts,
          state,
        )) === "fresh"
      )
        overwritten = true;
    }
    const target = arguments_[0];
    if (target !== undefined && !t.isSpreadElement(target))
      inputs.push({
        source: target,
        first,
        ...(overwritten ? { copyKeepsCache: false } : {}),
      });
    return inputs;
  }
  if (t.isCallExpression(root)) {
    if (
      invocation?.kind === "known" &&
      invocation.path[1] === "Object" &&
      ["defineProperty", "defineProperties"].includes(
        invocation.path.at(-1) ?? "",
      )
    ) {
      const target = invocation.arguments?.[0];
      if (target !== undefined && !t.isSpreadElement(target))
        return [{ source: target, first }];
    }
    if (
      invocation?.kind === "known" &&
      invocation.path.join(".") === "intrinsic.Object.create"
    ) {
      const prototype = invocation.arguments?.[0];
      if (prototype !== undefined && !t.isSpreadElement(prototype))
        return [{ source: prototype, first, copyKeepsCache: true }];
    }
  }
  if (t.isConditionalExpression(root))
    return [
      { source: root.consequent, first },
      { source: root.alternate, first },
    ];
  if (t.isLogicalExpression(root))
    return [
      { source: root.left, first },
      { source: root.right, first },
    ];
  const source = t.isSequenceExpression(root)
    ? root.expressions.at(-1)
    : t.isAssignmentExpression(root, { operator: "=" })
      ? root.right
      : undefined;
  return source === undefined ? [] : [{ source, first }];
}

type SpreadCacheFact = "fresh" | "possible" | "absent";

function* freshCacheReplacementSteps(
  node: t.Node,
  facts: WeakMap<t.Node, boolean>,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, boolean> {
  const pending: {
    readonly node: t.Node;
    phase: "visit" | "alias" | "binding" | "container";
    resultNode?: t.Node;
    bindingId?: string;
    children?: Generator<t.Node | undefined>;
    expression?: t.ArrayExpression | t.ObjectExpression;
    fresh?: boolean;
    pendingChild?: t.Node;
  }[] = [{ node, phase: "visit" }];
  const activeBindings = new Set<string>();
  let examined = 0;
  while (pending.length > 0) {
    if (examined++ % 1024 === 0) yield;
    const current = pending.at(-1);
    if (current === undefined) break;
    if (current.phase === "alias" || current.phase === "binding") {
      if (current.phase === "binding" && current.bindingId !== undefined)
        activeBindings.delete(current.bindingId);
      const fresh =
        current.resultNode !== undefined &&
        facts.get(current.resultNode) === true;
      facts.set(current.node, fresh);
      facts.set(unwrapJavaScriptExpression(current.node).node, fresh);
      pending.pop();
      continue;
    }
    if (current.phase === "container") {
      if (current.pendingChild !== undefined) {
        if (facts.get(current.pendingChild) !== true) current.fresh = false;
        delete current.pendingChild;
      }
      const child = current.children?.next();
      if (child === undefined || child.done) {
        const fresh = current.fresh === true;
        if (current.expression !== undefined)
          facts.set(current.expression, fresh);
        facts.set(current.node, fresh);
        pending.pop();
      } else if (child.value === undefined) {
        continue;
      } else if (facts.get(child.value) === false) {
        current.fresh = false;
      } else if (!facts.has(child.value)) {
        current.pendingChild = child.value;
        pending.push({ node: child.value, phase: "visit" });
      }
      continue;
    }
    if (facts.has(current.node)) {
      pending.pop();
      continue;
    }
    const expression = unwrapJavaScriptExpression(current.node).node;
    if (expression !== current.node && facts.has(expression)) {
      facts.set(current.node, facts.get(expression) ?? false);
      pending.pop();
      continue;
    }
    if (expression !== current.node) {
      current.phase = "alias";
      current.resultNode = expression;
      pending.push({ node: expression, phase: "visit" });
      continue;
    }
    if (t.isIdentifier(expression)) {
      const binding = resolveSemanticBindingState(
        state,
        expression,
        expression.name,
      );
      const initializer = semanticStableInitializer(binding, state);
      if (
        binding === undefined ||
        initializer === undefined ||
        (initializer.node.end ?? Infinity) >= (expression.start ?? -1) ||
        binding.memberWrites.length > 0 ||
        binding.escapedPaths.length > 0 ||
        activeBindings.has(binding.bindingId)
      ) {
        facts.set(current.node, false);
        facts.set(expression, false);
        pending.pop();
        continue;
      }
      activeBindings.add(binding.bindingId);
      current.phase = "binding";
      current.bindingId = binding.bindingId;
      current.resultNode = initializer.node;
      pending.push({ node: initializer.node, phase: "visit" });
      continue;
    }
    if (
      t.isFunction(expression) ||
      t.isStringLiteral(expression) ||
      t.isNumericLiteral(expression) ||
      t.isBooleanLiteral(expression) ||
      t.isNullLiteral(expression) ||
      t.isRegExpLiteral(expression)
    ) {
      facts.set(current.node, true);
      facts.set(expression, true);
      pending.pop();
      continue;
    }
    if (!t.isArrayExpression(expression) && !t.isObjectExpression(expression)) {
      facts.set(current.node, false);
      facts.set(expression, false);
      pending.pop();
      continue;
    }
    if (t.isObjectExpression(expression)) {
      let unsupportedProperty = false;
      for (const property of expression.properties) {
        if (!t.isSpreadElement(property) && !t.isObjectProperty(property))
          unsupportedProperty = true;
        if (examined++ % 1024 === 0) yield;
      }
      if (unsupportedProperty) {
        facts.set(current.node, false);
        facts.set(expression, false);
        pending.pop();
        continue;
      }
    }
    current.phase = "container";
    current.expression = expression;
    current.children = freshContainerValues(expression);
    current.fresh = true;
  }
  return facts.get(node) === true;
}

function* freshContainerValues(
  node: t.ArrayExpression | t.ObjectExpression,
): Generator<t.Node | undefined> {
  if (t.isArrayExpression(node)) {
    for (const element of node.elements)
      yield element === null
        ? undefined
        : t.isSpreadElement(element)
          ? element.argument
          : element;
    return;
  }
  for (const property of node.properties)
    if (t.isSpreadElement(property)) yield property.argument;
    else if (t.isObjectProperty(property)) yield property.value;
}

/** Read later literal spread keys once; unknown keys never prove lost ownership. */
function* spreadCacheFactSteps(
  node: t.Node,
  facts: WeakMap<t.Node, SpreadCacheFact>,
  freshFacts: WeakMap<t.Node, boolean>,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, SpreadCacheFact> {
  const pending = [{ node, finish: false }];
  let examined = 0;
  while (pending.length > 0) {
    if (examined++ % 1024 === 0) yield;
    const current = pending.pop();
    if (current === undefined || facts.has(current.node)) continue;
    if (!t.isObjectExpression(current.node)) {
      if (t.isIdentifier(current.node)) {
        facts.set(current.node, "possible");
        continue;
      }
      facts.set(
        current.node,
        (yield* freshCacheReplacementSteps(current.node, freshFacts, state))
          ? "absent"
          : "possible",
      );
      continue;
    }
    if (!current.finish) {
      pending.push({ ...current, finish: true });
      for (const property of current.node.properties) {
        if (t.isSpreadElement(property))
          pending.push({ node: property.argument, finish: false });
        if (examined++ % 1024 === 0) yield;
      }
      continue;
    }
    let result: SpreadCacheFact = "absent";
    for (let index = current.node.properties.length - 1; index >= 0; index--) {
      const property = current.node.properties[index];
      if (property === undefined) continue;
      if (t.isSpreadElement(property)) {
        result = facts.get(property.argument) ?? "possible";
        if (result !== "absent") break;
      } else {
        const key = semanticStaticPropertyKey(property.key, property.computed);
        if (key === null) {
          result = "possible";
          break;
        }
        if (key === "f") {
          result =
            t.isObjectProperty(property) &&
            (yield* freshCacheReplacementSteps(
              property.value,
              freshFacts,
              state,
            ))
              ? "fresh"
              : "possible";
          break;
        }
      }
    }
    facts.set(current.node, result);
  }
  return facts.get(node) ?? "possible";
}

const joinOwnership = (
  previous: CacheOwnership | undefined,
  incoming: CacheOwnership,
): CacheOwnership => {
  if (previous === undefined) return incoming;
  const joined = {
    owner: previous.owner === incoming.owner ? previous.owner : null,
    first: previous.first === incoming.first ? previous.first : null,
    direct: previous.direct || incoming.direct,
    shared: previous.shared || incoming.shared,
    child: previous.child === incoming.child ? previous.child : null,
  };
  return joined.owner === previous.owner &&
    joined.first === previous.first &&
    joined.direct === previous.direct &&
    joined.shared === previous.shared &&
    joined.child === previous.child
    ? previous
    : joined;
};

/** A container's shared child survives a shallow copy; the cache array itself does not. */
const copyOwnership = (
  source: CacheOwnership,
  alias: CacheAlias,
): CacheOwnership => {
  let child =
    source.direct && source.child === undefined
      ? source.first === undefined
        ? "f"
        : null
      : source.child;
  const definiteCache =
    source.direct && source.first === "f" && source.child === undefined;
  const keepsChild =
    (child !== "f" || alias.copyKeepsCache === true) &&
    (typeof child !== "string" ||
      semanticPropertyPathKeyMatches(
        {
          excludedKeys: alias.copyExcludedKeys ?? [],
          ...(alias.copyStartIndex === undefined
            ? {}
            : { startIndex: alias.copyStartIndex }),
        },
        child,
      ));
  if (typeof child === "string" && alias.copyStartIndex !== undefined) {
    const index = semanticArrayIndex(child);
    child = index === null ? null : String(index - alias.copyStartIndex);
  }
  return {
    ...source,
    direct: false,
    child,
    shared: source.shared && !definiteCache && keepsChild,
  };
};

const selectOwnership = (
  source: CacheOwnership | undefined,
  first: CacheKey,
): CacheOwnership | undefined => {
  if (source === undefined || first === undefined) return source;
  if (!source.shared) return undefined;
  return {
    owner: source.owner,
    first: source.first === undefined ? first : source.first,
    direct: true,
    shared: true,
    child: source.direct ? source.child : null,
  };
};

/** only the first owned key distinguishes the admitted cache from other members. */
const viteAliasSources = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  facts: ReadonlyMap<AliasVertex, CacheOwnership>,
  detachments: CacheDetachments,
  first: CacheKey = undefined,
): ReadonlyMap<AliasVertex, CacheKey> => {
  const sources = new Map<AliasVertex, CacheKey>();
  const pending = [{ node, first }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const { root, members } = electronMemberPath(current.node);
    const key = members.length === 0 ? current.first : members[0];
    if (t.isIdentifier(root)) {
      const binding = resolveSemanticBindingState(state, root, root.name);
      if (binding === undefined) continue;
      if (
        typeof key === "string" &&
        detachedCacheAt(
          binding.bindingId,
          key,
          current.node,
          detachments,
          state,
        )
      )
        continue;
      const member =
        key === undefined || key === null
          ? undefined
          : viteCacheMemberVertex(
              binding.bindingId,
              key,
              detachments.identities,
            );
      const candidates =
        member !== undefined && facts.has(member)
          ? semanticStableInitializer(binding, state) === undefined ||
            (facts.get(binding.bindingId) !== undefined &&
              facts.get(binding.bindingId)?.owner !== facts.get(member)?.owner)
            ? [member, binding.bindingId]
            : [member]
          : [binding.bindingId];
      for (const source of candidates) {
        const selectedKey =
          source === member ? (members[1] ?? current.first) : key;
        const previous = sources.get(source);
        sources.set(
          source,
          sources.has(source) && previous !== selectedKey ? null : selectedKey,
        );
      }
    } else if (facts.has(root)) sources.set(root, key);
    else if (t.isConditionalExpression(root))
      pending.push(
        { node: root.consequent, first: key },
        { node: root.alternate, first: key },
      );
    else if (t.isLogicalExpression(root))
      pending.push(
        { node: root.left, first: key },
        { node: root.right, first: key },
      );
    else if (t.isSequenceExpression(root)) {
      const last = root.expressions.at(-1);
      if (last !== undefined) pending.push({ node: last, first: key });
    } else if (t.isAssignmentExpression(root, { operator: "=" }))
      pending.push({ node: root.right, first: key });
  }
  return sources;
};

const viteCacheMemberVertex = (
  binding: string,
  key: string,
  identities: ViteContainerIdentities,
): string =>
  `${identities.roots.get(binding) ?? binding}:vite-member:${JSON.stringify(key)}`;

interface CacheReplacement {
  readonly node: t.Node;
  readonly fresh: boolean;
  readonly block: t.Program | t.BlockStatement | undefined;
}
interface CacheDetachments {
  readonly identities: ViteContainerIdentities;
  readonly replacements: ReadonlyMap<string, readonly CacheReplacement[]>;
}

/** Alias identities own the full write journal, including intrinsic property writes. */
function* indexViteCacheDetachmentsSteps(
  state: JavaScriptSemanticAnalysisState,
): Generator<void, CacheDetachments> {
  const identities = yield* indexViteContainerIdentitiesSteps(state);
  const interop = createSemanticModuleInterop(state);
  const candidates = new Map<string, Map<t.Node, boolean>>();
  yield* collectJavaScriptIdentityWritesSteps(
    state.program,
    (node, kind) => {
      if (kind !== "member") return [];
      const { root, members } = electronMemberPath(node);
      if (!t.isIdentifier(root)) return [];
      const binding = resolveSemanticBindingState(state, root, root.name);
      const identity =
        binding === undefined
          ? undefined
          : identities.roots.get(binding.bindingId);
      return identity === undefined || !identities.detachable.has(identity)
        ? []
        : [[identity, ...members]];
    },
    interop.intrinsicInvocation,
    interop.staticString,
    interop.isFreshObject,
    (node, path) => {
      const identity = path[0];
      if (identity == null || path.length > 2) return;
      const key = path[1];
      const journal =
        typeof key === "string"
          ? viteCacheMemberVertex(identity, key, identities)
          : identity;
      const writes = candidates.get(journal) ?? new Map<t.Node, boolean>();
      const exact = path.length === 2 && typeof key === "string";
      writes.set(node, (writes.get(node) ?? true) && exact);
      candidates.set(journal, writes);
    },
  );
  const replacements = new Map<string, CacheReplacement[]>();
  const freshFacts = new WeakMap<t.Node, boolean>();
  for (const [identity, candidates_] of candidates) {
    const writes: CacheReplacement[] = [];
    for (const [node, exact] of candidates_) {
      yield;
      const block = straightLineBlock(node, state);
      const fresh =
        exact &&
        block !== undefined &&
        t.isAssignmentExpression(node, { operator: "=" }) &&
        (yield* freshCacheReplacementSteps(node.right, freshFacts, state));
      writes.push({ node, fresh, block });
    }
    writes.sort((a, b) => (a.node.end ?? Infinity) - (b.node.end ?? Infinity));
    replacements.set(identity, writes);
  }
  return { identities, replacements };
}

const straightLineBlock = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Program | t.BlockStatement | undefined => {
  let current: t.Node | undefined = node;
  while (current !== undefined && !t.isStatement(current)) {
    const parent = state.parentsByNode.get(current);
    if (
      t.isConditionalExpression(parent) ||
      t.isLogicalExpression(parent) ||
      t.isSequenceExpression(parent) ||
      t.isFunction(parent)
    )
      return undefined;
    current = parent;
  }
  if (!t.isExpressionStatement(current) && !t.isVariableDeclaration(current))
    return undefined;
  const block = state.parentsByNode.get(current);
  return t.isProgram(block) || t.isBlockStatement(block) ? block : undefined;
};

const detachedCacheAt = (
  binding: string,
  key: string,
  node: t.Node,
  replacements: CacheDetachments,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const block = straightLineBlock(node, state);
  if (block === undefined) return false;
  const identity = replacements.identities.roots.get(binding);
  if (
    identity === undefined ||
    !replacements.identities.detachable.has(identity)
  )
    return false;
  const replacement = [
    identity,
    viteCacheMemberVertex(identity, key, replacements.identities),
  ]
    .map((journal) =>
      latestCacheReplacement(
        replacements.replacements.get(journal) ?? [],
        node,
      ),
    )
    .reduce<CacheReplacement | undefined>(
      (latest, event) =>
        (event?.node.end ?? -1) > (latest?.node.end ?? -1) ? event : latest,
      undefined,
    );
  return replacement?.fresh === true && replacement.block === block;
};

const latestCacheReplacement = (
  writes: readonly CacheReplacement[],
  node: t.Node,
): CacheReplacement | undefined => {
  let low = 0;
  let high = writes.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((writes[middle]?.node.end ?? Infinity) < (node.start ?? -1))
      low = middle + 1;
    else high = middle;
  }
  return writes[low - 1];
};
