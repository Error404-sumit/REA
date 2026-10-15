import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { invalidateJavaScriptViteCachesSteps } from "./javascriptViteCacheOwnership.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAstSteps } from "./javascriptSemanticTraversal.js";
import type { ParsedJavaScriptSource } from "./javascriptSourceParser.js";

type ViteDependencyTable = readonly (string | undefined)[];
type ViteDependencyCall = t.CallExpression | t.OptionalCallExpression;
type ViteHelper =
  | t.ArrowFunctionExpression
  | t.FunctionExpression
  | t.FunctionDeclaration;

interface ViteHelperCandidate {
  readonly name: t.Identifier;
  readonly helper: ViteHelper;
  readonly table: t.ArrayExpression;
  readonly uncertain: boolean;
}

interface ViteHelperDefaults {
  readonly indexes: string;
  readonly map: string;
  readonly dependencies: string;
  readonly cache: t.Node;
  readonly returned: t.Node;
  readonly uncertain: boolean;
}

interface LoweredParameterDefault {
  readonly fallback: t.Node;
  readonly uncertain: boolean;
}

/** resolve emitted Vite helpers by lexical identity without executing them. */
export function* classifyParsedJavaScriptViteDependencySpecifiersSteps(
  file: ParsedJavaScriptSource,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, ReadonlyMap<ViteDependencyCall, ViteDependencyTable>> {
  const candidates: ViteHelperCandidate[] = [];
  yield* traverseJavaScriptAstSteps(file.program, {
    enter: (node) => {
      const candidate = viteHelperCandidate(node, state);
      if (candidate !== undefined) candidates.push(candidate);
    },
  });
  const calls = new Map<ViteDependencyCall, ViteDependencyTable>();
  if (candidates.length === 0) return calls;
  const tables = yield* viteBindingTablesSteps(candidates, state);
  const initializations = new Set(
    candidates.map(({ table }) => state.parentsByNode.get(table)),
  );
  yield* invalidateJavaScriptViteCachesSteps(
    file.program,
    tables,
    initializations,
    state,
  );
  const selectedCalls: ViteDependencyCall[] = [];
  yield* traverseJavaScriptAstSteps(file.program, {
    enter: (node) => {
      if (
        (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) ||
        !t.isIdentifier(node.callee, { name: "__vite__mapDeps" })
      )
        return;
      selectedCalls.push(node);
    },
  });
  for (const node of selectedCalls) {
    yield;
    const binding = resolveSemanticBindingState(
      state,
      node.callee,
      "__vite__mapDeps",
    );
    if (binding !== undefined && tables.has(binding.bindingId))
      calls.set(
        node,
        yield* selectedDependencySpecifiersSteps(
          node,
          tables.get(binding.bindingId),
          state,
        ),
      );
  }
  return calls;
}

function* viteBindingTablesSteps(
  candidates: readonly ViteHelperCandidate[],
  state: JavaScriptSemanticAnalysisState,
): Generator<void, Map<string, ViteDependencyTable | null>> {
  const tables = new Map<string, ViteDependencyTable | null>();
  for (const { name, helper, table, uncertain } of candidates) {
    const binding = resolveSemanticBindingState(state, name, name.name);
    if (binding === undefined) continue;
    const initializer = semanticStableInitializer(binding, state);
    const unchanged =
      !uncertain &&
      initializer !== undefined &&
      unwrapJavaScriptExpression(initializer.node).node === helper &&
      initializer.projection.length === 0;
    yield;
    tables.set(
      binding.bindingId,
      unchanged ? yield* exactTableSlotsSteps(table) : null,
    );
  }
  return tables;
}

function* exactTableSlotsSteps(
  table: t.ArrayExpression,
): Generator<void, ViteDependencyTable> {
  const slots: (string | undefined)[] = [];
  for (let index = 0; index < table.elements.length; index++) {
    if (index % 1024 === 0) yield;
    const element = table.elements[index];
    if (t.isSpreadElement(element)) break;
    slots.push(t.isStringLiteral(element) ? element.value : undefined);
  }
  return slots;
}

const viteHelperCandidate = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): ViteHelperCandidate | undefined => {
  const declaration = viteHelperDeclaration(node);
  if (declaration === undefined) return undefined;
  const { name, helper } = declaration;
  const defaults =
    helper.params.length === 3
      ? (parameterDefaults(helper, name.name) ??
        assignmentGuardedDefaults(helper, name.name, state))
      : loweredDefaults(helper, name.name, state);
  if (defaults === undefined) return undefined;
  const parameterNames = new Set([
    defaults.indexes,
    defaults.map,
    defaults.dependencies,
  ]);
  if (parameterNames.size !== 3 || parameterNames.has(name.name))
    return undefined;
  const { cache } = defaults;
  if (
    !t.isLogicalExpression(cache, { operator: "||" }) ||
    !isNamedMember(cache.left, defaults.map, "f") ||
    !t.isAssignmentExpression(cache.right, { operator: "=" }) ||
    !isNamedMember(cache.right.left, defaults.map, "f") ||
    !t.isArrayExpression(cache.right.right) ||
    !mapsDependencyIndexes(
      defaults.returned,
      defaults.indexes,
      defaults.dependencies,
    )
  )
    return undefined;
  return {
    name,
    helper,
    table: cache.right.right,
    uncertain:
      defaults.uncertain ||
      state.ambientWrites.covers(["global", "Array", "prototype", "map"]) ||
      state.ambientWrites.covers(["global", "Function", "prototype", "f"]) ||
      state.ambientWrites.covers(["global", "Object", "prototype", "f"]),
  };
};

const viteHelperDeclaration = (
  node: t.Node,
): Pick<ViteHelperCandidate, "name" | "helper"> | undefined => {
  const name =
    t.isVariableDeclarator(node) || t.isFunctionDeclaration(node)
      ? node.id
      : undefined;
  const initializer = t.isVariableDeclarator(node) ? node.init : node;
  if (!t.isIdentifier(name, { name: "__vite__mapDeps" }) || initializer == null)
    return undefined;
  const helper = unwrapJavaScriptExpression(initializer).node;
  if (
    (!t.isArrowFunctionExpression(helper) &&
      !t.isFunctionExpression(helper) &&
      !t.isFunctionDeclaration(helper)) ||
    helper.async ||
    (!t.isArrowFunctionExpression(helper) && helper.generator)
  )
    return undefined;
  return { name, helper };
};

const parameterDefaults = (
  helper: ViteHelper,
  name: string,
): ViteHelperDefaults | undefined => {
  const [indexes, map, dependencies] = helper.params;
  if (
    !t.isIdentifier(indexes) ||
    !t.isAssignmentPattern(map) ||
    !t.isIdentifier(map.left) ||
    !t.isIdentifier(map.right, { name }) ||
    !t.isAssignmentPattern(dependencies) ||
    !t.isIdentifier(dependencies.left)
  )
    return undefined;
  const returned = singleReturnedExpression(helper.body);
  if (returned === undefined) return undefined;
  return {
    indexes: indexes.name,
    map: map.left.name,
    dependencies: dependencies.left.name,
    cache: dependencies.right,
    returned,
    uncertain: false,
  };
};

/** Read TypeScript's assignment-guarded defaults before rejecting plain parameters. */
const assignmentGuardedDefaults = (
  helper: ViteHelper,
  name: string,
  state: JavaScriptSemanticAnalysisState,
): ViteHelperDefaults | undefined => {
  if (
    t.isArrowFunctionExpression(helper) ||
    helper.params.length !== 3 ||
    !t.isIdentifier(helper.params[0]) ||
    !t.isIdentifier(helper.params[1]) ||
    !t.isIdentifier(helper.params[2]) ||
    !t.isBlockStatement(helper.body)
  )
    return undefined;
  const [indexes, map, dependencies] = helper.params;
  const returnedStatement = helper.body.body.at(-1);
  const returned = t.isReturnStatement(returnedStatement)
    ? returnedStatement.argument
    : undefined;
  if (returned == null) return undefined;
  const expressions = [
    ...helper.body.body.slice(0, -1),
    ...(t.isSequenceExpression(returned) ? returned.expressions : [returned]),
  ];
  if (expressions.length !== 3) return undefined;
  const [mapGuard, dependenciesGuard, projection] = expressions;
  if (
    indexes === undefined ||
    map === undefined ||
    dependencies === undefined ||
    returnedStatement === undefined ||
    !t.isReturnStatement(returnedStatement) ||
    returnedStatement.argument == null
  )
    return undefined;
  const mapDefault = assignmentGuardedParameterDefault(
    mapGuard,
    map.name,
    state,
  );
  const dependenciesDefault = assignmentGuardedParameterDefault(
    dependenciesGuard,
    dependencies.name,
    state,
  );
  if (
    mapDefault === undefined ||
    !t.isIdentifier(mapDefault.fallback, { name }) ||
    dependenciesDefault === undefined
  )
    return undefined;
  return {
    indexes: indexes.name,
    map: map.name,
    dependencies: dependencies.name,
    cache: dependenciesDefault.fallback,
    returned: projection ?? returnedStatement.argument,
    uncertain: mapDefault.uncertain || dependenciesDefault.uncertain,
  };
};

const assignmentGuardedParameterDefault = (
  statement: t.Node | undefined,
  name: string,
  state: JavaScriptSemanticAnalysisState,
): LoweredParameterDefault | undefined => {
  const test =
    t.isIfStatement(statement) && statement.alternate === null
      ? statement.test
      : t.isLogicalExpression(statement, { operator: "&&" })
        ? statement.left
        : t.isExpressionStatement(statement) &&
            t.isLogicalExpression(statement.expression, { operator: "&&" })
          ? statement.expression.left
          : undefined;
  if (test === undefined || !t.isBinaryExpression(test, { operator: "===" }))
    return undefined;
  const undefinedValue = t.isIdentifier(test.left, { name })
    ? test.right
    : t.isIdentifier(test.right, { name })
      ? test.left
      : undefined;
  if (undefinedValue === undefined) return undefined;
  const exactUndefined = defaultUndefined(undefinedValue, state);
  if (!exactUndefined && !t.isIdentifier(undefinedValue, { name: "undefined" }))
    return undefined;
  const consequent = t.isIfStatement(statement)
    ? statement.consequent
    : t.isLogicalExpression(statement, { operator: "&&" })
      ? statement.right
      : t.isExpressionStatement(statement) &&
          t.isLogicalExpression(statement.expression, { operator: "&&" })
        ? statement.expression.right
        : undefined;
  const assignment = t.isExpressionStatement(consequent)
    ? consequent.expression
    : t.isBlockStatement(consequent) &&
        consequent.body.length === 1 &&
        t.isExpressionStatement(consequent.body[0])
      ? consequent.body[0].expression
      : consequent;
  return t.isAssignmentExpression(assignment, { operator: "=" }) &&
    t.isIdentifier(assignment.left, { name })
    ? { fallback: assignment.right, uncertain: !exactUndefined }
    : undefined;
};

const loweredDefaults = (
  helper: ViteHelper,
  name: string,
  state: JavaScriptSemanticAnalysisState,
): ViteHelperDefaults | undefined => {
  if (
    t.isArrowFunctionExpression(helper) ||
    helper.params.length !== 1 ||
    !t.isIdentifier(helper.params[0])
  )
    return undefined;
  const returned = helper.body.body.at(-1);
  if (!t.isReturnStatement(returned) || returned.argument == null)
    return undefined;
  const declarations = loweredDeclarations(helper.body);
  if (declarations === undefined) return undefined;
  const [map, dependencies] = declarations;
  if (
    map === undefined ||
    dependencies === undefined ||
    !t.isIdentifier(map.id) ||
    !t.isIdentifier(dependencies.id)
  )
    return undefined;
  const mapDefault = loweredParameterDefault(map.init, 1, state);
  const dependenciesDefault = loweredParameterDefault(
    dependencies.init,
    2,
    state,
  );
  if (
    mapDefault === undefined ||
    !t.isIdentifier(mapDefault.fallback, { name }) ||
    dependenciesDefault === undefined
  )
    return undefined;
  return {
    indexes: helper.params[0].name,
    map: map.id.name,
    dependencies: dependencies.id.name,
    cache: dependenciesDefault.fallback,
    returned: returned.argument,
    uncertain:
      mapDefault.uncertain ||
      dependenciesDefault.uncertain ||
      new Set([helper.params[0].name, map.id.name, dependencies.id.name]).has(
        "arguments",
      ),
  };
};

const loweredDeclarations = (
  body: t.BlockStatement,
): readonly t.VariableDeclarator[] | undefined => {
  if (body.body.length < 2 || body.body.length > 3) return undefined;
  const declarations: t.VariableDeclarator[] = [];
  for (const statement of body.body.slice(0, -1)) {
    if (
      !t.isVariableDeclaration(statement) ||
      statement.declarations.length > 2
    )
      return undefined;
    declarations.push(...statement.declarations);
  }
  return declarations.length === 2 ? declarations : undefined;
};

/** Babel lowers each default to a guarded lookup of the same argument index. */
const loweredParameterDefault = (
  node: t.Node | null | undefined,
  index: number,
  state: JavaScriptSemanticAnalysisState,
): LoweredParameterDefault | undefined => {
  if (!t.isConditionalExpression(node)) return undefined;
  const { test } = node;
  if (
    !t.isLogicalExpression(test, { operator: "&&" }) ||
    !t.isBinaryExpression(test.left, { operator: ">" }) ||
    !isNamedMember(test.left.left, "arguments", "length") ||
    !t.isNumericLiteral(test.left.right, { value: index }) ||
    !t.isBinaryExpression(test.right, { operator: "!==" }) ||
    !isArgumentIndex(test.right.left, index) ||
    !isArgumentIndex(node.consequent, index)
  )
    return undefined;
  const exactUndefined = defaultUndefined(test.right.right, state);
  if (
    !exactUndefined &&
    !t.isIdentifier(test.right.right, { name: "undefined" })
  )
    return undefined;
  return { fallback: node.alternate, uncertain: !exactUndefined };
};

const isArgumentIndex = (node: t.Node, index: number): boolean =>
  t.isMemberExpression(node) &&
  node.computed &&
  t.isIdentifier(node.object, { name: "arguments" }) &&
  t.isNumericLiteral(node.property, { value: index });

const defaultUndefined = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  node = unwrapJavaScriptExpression(node).node;
  return (
    isUnshadowedGlobal(node, state, "undefined") ||
    (t.isUnaryExpression(node, { operator: "void" }) &&
      readExactJavaScriptLiteral(node.argument).found)
  );
};

const singleReturnedExpression = (body: t.Node): t.Node | undefined => {
  if (!t.isBlockStatement(body)) return body;
  const [statement] = body.body;
  return body.body.length === 1 && t.isReturnStatement(statement)
    ? (statement.argument ?? undefined)
    : undefined;
};

const isNamedMember = (
  node: t.Node,
  object: string,
  property: string,
): boolean =>
  t.isMemberExpression(node) &&
  t.isIdentifier(node.object, { name: object }) &&
  semanticStaticPropertyKey(node.property, node.computed) === property;

const mapsDependencyIndexes = (
  body: t.Node,
  indexes: string,
  dependencies: string,
): boolean => {
  if (
    !t.isCallExpression(body) ||
    !isNamedMember(body.callee, indexes, "map") ||
    body.arguments.length !== 1
  )
    return false;
  const callback = body.arguments[0];
  if (
    (!t.isArrowFunctionExpression(callback) &&
      !t.isFunctionExpression(callback)) ||
    callback.async ||
    (t.isFunctionExpression(callback) &&
      (callback.generator || callback.id?.name === dependencies)) ||
    callback.params.length !== 1 ||
    !t.isIdentifier(callback.params[0]) ||
    callback.params[0].name === dependencies
  )
    return false;
  const returned = singleReturnedExpression(callback.body);
  return (
    t.isMemberExpression(returned) &&
    returned.computed &&
    t.isIdentifier(returned.object, { name: dependencies }) &&
    t.isIdentifier(returned.property, { name: callback.params[0].name })
  );
};

function* selectedDependencySpecifiersSteps(
  node: ViteDependencyCall,
  table: ViteDependencyTable | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, ViteDependencyTable> {
  if (table == null || !(yield* usesDefaultTableSteps(node, state)))
    return [undefined];
  const argument = node.arguments[0];
  if (argument === undefined) return [undefined];
  const indexes = unwrapJavaScriptExpression(argument).node;
  if (!t.isArrayExpression(indexes)) return [undefined];
  const selected: (string | undefined)[] = [];
  for (let index = 0; index < indexes.elements.length; index++) {
    if (index % 1024 === 0) yield;
    const element = indexes.elements[index];
    if (element == null) continue;
    const value = unwrapJavaScriptExpression(element).node;
    if (!t.isIdentifier(value) && !readExactJavaScriptLiteral(value).found)
      return [undefined];
    selected.push(
      t.isNumericLiteral(value) &&
        Number.isSafeInteger(value.value) &&
        value.value >= 0
        ? table[value.value]
        : undefined,
    );
  }
  return selected;
}

function* usesDefaultTableSteps(
  node: ViteDependencyCall,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, boolean> {
  for (const argument of node.arguments.slice(0, 3))
    if (t.isSpreadElement(argument)) return false;
  for (const index of [1, 2]) {
    const argument = node.arguments[index];
    if (argument !== undefined && !defaultUndefined(argument, state))
      return false;
  }
  for (let index = 3; index < node.arguments.length; index++) {
    if (index % 1024 === 0) yield;
    const argument = node.arguments[index];
    if (
      argument === undefined ||
      (!readExactJavaScriptLiteral(argument).found &&
        !defaultUndefined(argument, state))
    )
      return false;
  }
  return true;
}
