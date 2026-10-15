import * as t from "@babel/types";

import { unwrapJavaScriptExpression } from "./javascriptAstValues.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAstSteps } from "./javascriptSemanticTraversal.js";

export interface ViteContainerIdentities {
  readonly roots: ReadonlyMap<string, string>;
  readonly detachable: ReadonlySet<string>;
  readonly unresolved: ReadonlySet<string>;
}

/** A single top-level assignment also establishes identity once the value exists. */
const containerInitializer = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
) => {
  const stable = semanticStableInitializer(binding, state);
  if (stable !== undefined) return stable;
  const [initializer] = binding.initializers;
  if (
    initializer === undefined ||
    binding.initializers.length !== 1 ||
    !binding.definitions.every(
      ({ kind }) => kind === "variable" || kind === "assignment",
    ) ||
    state.conditionallySkippedExpressions.has(initializer.node)
  )
    return undefined;
  let parent = state.parentsByNode.get(initializer.node);
  if (
    !t.isAssignmentExpression(parent, { operator: "=" }) ||
    parent.right !== initializer.node
  )
    return undefined;
  while (parent !== undefined && !t.isProgram(parent)) {
    if (
      !t.isAssignmentExpression(parent) &&
      !t.isExpressionStatement(parent) &&
      !t.isBlockStatement(parent)
    )
      return undefined;
    parent = state.parentsByNode.get(parent);
  }
  return parent === undefined ? undefined : initializer;
};

/** Definite container aliases share one replacement journal; escaped identities cannot prove detachment. */
export function* indexViteContainerIdentitiesSteps(
  state: JavaScriptSemanticAnalysisState,
): Generator<void, ViteContainerIdentities> {
  const roots = new Map<string, string>();
  const uncertain = new Set<string>();
  const safeReads = new WeakSet<t.Node>();
  const interop = createSemanticModuleInterop(state);
  const find = (id: string): string => {
    let root = id;
    while (roots.get(root) !== root && roots.has(root)) root = roots.get(root)!;
    let current = id;
    while (roots.has(current) && roots.get(current) !== root) {
      const next = roots.get(current)!;
      roots.set(current, root);
      current = next;
    }
    return root;
  };
  for (const binding of state.bindingsById.values()) {
    yield;
    if (containerInitializer(binding, state) !== undefined)
      roots.set(binding.bindingId, binding.bindingId);
  }
  for (const binding of state.bindingsById.values()) {
    yield;
    const initializer = containerInitializer(binding, state);
    if (initializer === undefined) continue;
    const value = unwrapJavaScriptExpression(initializer.node).node;
    const invocation = t.isCallExpression(value)
      ? interop.intrinsicInvocation(value)
      : undefined;
    const assignment =
      invocation?.kind === "known" &&
      invocation.path[1] === "Object" &&
      ["assign", "defineProperty", "defineProperties"].includes(
        invocation.path.at(-1) ?? "",
      );
    const identity = assignment ? invocation.arguments?.[0] : value;
    if (initializer.projection.length === 0 && t.isIdentifier(identity)) {
      const source = resolveSemanticBindingState(
        state,
        identity,
        identity.name,
      );
      if (source !== undefined && roots.has(source.bindingId)) {
        roots.set(find(binding.bindingId), find(source.bindingId));
        safeReads.add(value);
        safeReads.add(identity);
      } else uncertain.add(binding.bindingId);
    } else if (
      initializer.projection.length !== 0 ||
      !(
        t.isObjectExpression(identity) ||
        t.isArrayExpression(identity) ||
        t.isFunction(identity)
      )
    )
      uncertain.add(binding.bindingId);
  }
  const unresolved = new Set([...uncertain].map(find));
  yield* traverseJavaScriptAstSteps(state.program, {
    enter: (node, parent) => {
      if (
        !t.isIdentifier(node) ||
        parent === null ||
        !t.isReferenced(node, parent, state.parentsByNode.get(parent)) ||
        safeReads.has(node)
      )
        return;
      const binding = resolveSemanticBindingState(state, node, node.name);
      if (binding === undefined || !roots.has(binding.bindingId)) return;
      if (
        (t.isMemberExpression(parent) ||
          t.isOptionalMemberExpression(parent)) &&
        parent.object === node
      )
        return;
      if (
        t.isSpreadElement(parent) &&
        t.isObjectExpression(state.parentsByNode.get(parent))
      )
        return;
      if (t.isCallExpression(parent)) {
        const invocation = interop.intrinsicInvocation(parent);
        if (
          invocation?.kind === "known" &&
          invocation.path[1] === "Object" &&
          ["assign", "defineProperty", "defineProperties"].includes(
            invocation.path.at(-1) ?? "",
          )
        ) {
          const index = invocation.arguments?.indexOf(node) ?? -1;
          if (index > 0 && invocation.path.at(-1) === "assign") return;
          const container = state.parentsByNode.get(parent);
          if (
            index === 0 &&
            (safeReads.has(parent) || t.isExpressionStatement(container))
          )
            return;
        }
      }
      uncertain.add(binding.bindingId);
    },
  });
  const uncertainRoots = new Set([...uncertain].map(find));
  const identities = new Map<string, string>();
  for (const id of roots.keys()) {
    yield;
    const root = find(id);
    identities.set(id, root);
  }
  return {
    roots: identities,
    unresolved,
    detachable: new Set(
      [...identities.values()].filter((root) => !uncertainRoots.has(root)),
    ),
  };
}
