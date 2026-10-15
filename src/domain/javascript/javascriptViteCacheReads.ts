import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

const ARRAY_READS = new Set([
  "at",
  "includes",
  "indexOf",
  "lastIndexOf",
  "slice",
]);
type ExactReceiver = "helper" | "cache" | "unknown";

/** Possible ownership cannot prove that a receiver still has an intrinsic method. */
export function* createViteCacheReadProofSteps(
  tables: ReadonlyMap<string, readonly (string | undefined)[] | null>,
  state: JavaScriptSemanticAnalysisState,
) {
  const denseOwners = new Set<string>();
  let examined = 0;
  for (const [owner, table] of tables) {
    let dense = table !== null;
    for (const value of table ?? []) {
      if (examined++ % 1024 === 0) yield;
      if (value === undefined) dense = false;
    }
    if (dense) denseOwners.add(owner);
  }
  const receivers = new WeakMap<t.Node, ExactReceiver>();
  const writes = new Map<string | null, Set<string>>();
  const exactReceiver = (node: t.Node): ExactReceiver => {
    const pending: { node: t.Node; selection: boolean }[] = [];
    const active = new Set<t.Node>();
    let value: ExactReceiver = "unknown";
    for (;;) {
      const prior = receivers.get(node);
      if (prior !== undefined) {
        value = prior;
        break;
      }
      if (active.has(node)) break;
      active.add(node);
      const expression = unwrapJavaScriptExpression(node).node;
      if (expression !== node) {
        pending.push({ node, selection: false });
        node = expression;
        continue;
      }
      if (t.isIdentifier(node)) {
        const binding = resolveSemanticBindingState(state, node, node.name);
        if (binding !== undefined && tables.has(binding.bindingId)) {
          receivers.set(node, "helper");
          value = "helper";
          break;
        }
        const initializer = semanticStableInitializer(binding, state);
        if (initializer === undefined || initializer.projection.length !== 0)
          break;
        pending.push({ node, selection: false });
        node = initializer.node;
      } else if (
        (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
        semanticStaticPropertyKey(node.property, node.computed) === "f"
      ) {
        pending.push({ node, selection: true });
        node = node.object;
      } else break;
    }
    receivers.set(node, value);
    for (const entry of pending.toReversed()) {
      if (entry.selection) value = value === "helper" ? "cache" : "unknown";
      receivers.set(entry.node, value);
    }
    return value;
  };
  return {
    recordWrite(path: readonly (string | null)[]): void {
      const owner = path[0];
      const key = path[2];
      if (owner === undefined || path.length !== 3 || key == null) return;
      const methods = writes.get(owner) ?? new Set<string>();
      methods.add(key);
      writes.set(owner, methods);
    },
    isRead(
      receiver: t.Node,
      method: string | null,
      arguments_: readonly t.CallExpression["arguments"][number][],
      paths: readonly (readonly (string | null)[])[],
    ): boolean {
      return (
        method !== null &&
        ARRAY_READS.has(method) &&
        exactReceiver(receiver) === "cache" &&
        paths.every((path) => path[0] != null && denseOwners.has(path[0])) &&
        !state.ambientWrites.covers(["global", "Array", "prototype", method]) &&
        (method !== "slice" ||
          !state.ambientWrites.covers([
            "global",
            "Array",
            "prototype",
            "constructor",
          ])) &&
        arguments_.every(
          (argument) => readExactJavaScriptLiteral(argument).found,
        ) &&
        [...paths.map((path) => path[0] ?? null), null].every(
          (owner) =>
            !writes.get(owner)?.has(method) &&
            (method !== "slice" || !writes.get(owner)?.has("constructor")),
        )
      );
    },
  };
}
