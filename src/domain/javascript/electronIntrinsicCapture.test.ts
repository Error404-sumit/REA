import { describe, expect, it } from "vitest";
import * as t from "@babel/types";

import { ROLLDOWN_MODULE_INTEROP } from "./javascriptModuleInterop.fixture.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronMemberPath,
} from "./javascriptElectronMemberWrites.js";
import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

const CAPTURED_INTEROP = ROLLDOWN_MODULE_INTEROP.replace(
  "__defProp = Object.defineProperty",
  "__defProp = define",
);
const WINDOW = `let electron = require("electron");
  electron = __toESM(electron, 1); new electron.BrowserWindow({});`;

/**
 * Resolve each call in one source through the same interop boundary the
 * identity traversal uses. `kind: "opaque"` means the callee names an
 * intrinsic invocation member read whose callable cannot be determined:
 * unknown effect, neither an effect-free call nor a confirmed write.
 */
const invocationKinds = (source: string) => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("invocation fixture did not parse");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const interop = createSemanticModuleInterop(state);
  const invocations: (ReturnType<typeof interop.intrinsicInvocation> | null)[] =
    [];
  traverseJavaScriptAst(parsed.program, {
    enter: (node) => {
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
        invocations.push(interop.intrinsicInvocation(node) ?? null);
    },
  });
  return { interop, invocations, parsed };
};

/**
 * Run the real identity-write collection and record each retained write plus
 * each call's invocation classification at the moment it was decided. Writes
 * feed `interop.retainWrite` so later reads observe earlier mutations — the
 * write-free `invocationKinds` helper cannot exercise read timing.
 */
const collectedWrites = (source: string) => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("invocation fixture did not parse");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const interop = createSemanticModuleInterop(state);
  const invocations: (
    | ReturnType<typeof interop.intrinsicInvocation>
    | undefined
  )[] = [];
  const writes: (readonly (string | null)[])[] = [];
  completeSemanticSteps(
    collectJavaScriptIdentityWritesSteps(
      parsed.program,
      (node, kind) => {
        if (kind === "opaque-call") return [interop.opaqueMutationPath(node)];
        const { root, members } = electronMemberPath(node);
        const path =
          interop.intrinsicPath(root) ??
          (kind === "member"
            ? (interop.boundIntrinsic(root)?.path ??
              interop.capturedInvocationMemberPath(root))
            : undefined);
        return path === undefined ? [] : [[...path, ...members]];
      },
      (node) => {
        const invocation = interop.intrinsicInvocation(node);
        invocations.push(invocation);
        return invocation;
      },
      interop.staticString,
      interop.isFreshObject,
      (node, path, kind) => {
        writes.push(path);
        interop.retainWrite(node, path, kind);
      },
      interop.observeEvaluation,
    ),
  );
  return { invocations, writes };
};

describe("captured intrinsic invocation reads", () => {
  it.each([
    '[Object.defineProperty, ignored = Object.defineProperty(metadata,"x",{value:1})] = [replacement];',
    '({first: Object.defineProperty, second: ignored = Object.defineProperty(metadata,"x",{value:1})} = values);',
    '[change.call, ignored = change.call(null,metadata,"x",{value:1})] = [replacement];',
    '({first: change.call, [change.call(null,metadata,"x",{value:1})]: ignored} = values);',
    'for ([change.call, ignored = change.call(null,metadata,"x",{value:1})] of values) {}',
  ])(
    "retains destructuring writes before later defaults and keys: %s",
    (mutation) => {
      const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      const change = define.bind(null);
      const metadata = {}; let ignored;
      ${mutation}
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
      expect(result.electron.browser_windows).toEqual([]);
    },
  );

  it("evaluates a destructuring RHS before any target writes", () => {
    const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      const metadata = {};
      [Object.defineProperty] = [Object.defineProperty(metadata,"x",{value:1}), replacement];
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it("evaluates assignment operands before recording their writes", () => {
    const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      const metadata = {};
      Object.defineProperty = (Object.defineProperty(metadata, "x", {value:1}), replacement);
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it("retains whole-object mutations at a captured function's later member read", () => {
    const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      Object.assign(define, {call: replacement});
      const metadata = {}; define.call(null, metadata, "x", {value:1});
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
    expect(result.electron.browser_windows).toEqual([]);
  });

  it("retains callee-prefix effects before classifying the invocation", () => {
    const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      const metadata = {};
      (Object.defineProperty = replacement, Object.defineProperty)(metadata,"x",{value:1});
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
    expect(result.electron.browser_windows).toEqual([]);
  });

  it("retains a callee selected before an argument replaces its global property", () => {
    const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      const metadata = {};
      Object.defineProperty(metadata,"x",(Object.defineProperty = replacement,{value:1}));
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it.each([
    'define.call(null,metadata,"x",{value:1});',
    'define.apply(null,[metadata,"x",{value:1}]);',
    'const change = define.bind(null,metadata,"x"); change({value:1});',
    'const also = define; also.call(null,metadata,"x",{value:1});',
  ])("retains a function captured before global replacement: %s", (invoke) => {
    const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      Object.defineProperty = replacement;
      const metadata = {}; ${invoke}
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it.each([
    ["call", 'define.call(null,metadata,"x",{value:1});'],
    ["apply", 'define.apply(null,[metadata,"x",{value:1}]);'],
    [
      "bind",
      'const change = define.bind(null,metadata,"x"); change({value:1});',
    ],
  ])(
    "checks the later %s property read on a captured function",
    (method, invoke) => {
      for (const owner of ["define", "Function.prototype"]) {
        const result = analyzeJavaScriptStaticSource(`
        const define = Object.defineProperty;
        ${owner}.${method} = replacement;
        const metadata = {}; ${invoke}
        ${CAPTURED_INTEROP} ${WINDOW}
      `);
        expect(result.electron.browser_windows, owner).toEqual([]);
      }
    },
  );
});

describe("identifier-aliased intrinsic invocation members", () => {
  it.each(["call", "apply"])(
    "preserves a detached bound %s member's explicit receiver",
    (method) => {
      const source = `const change = Object.defineProperty.bind(null,Object,"create");
      const noop = () => {}; Reflect.apply(change.${method}, noop,
      [null, ${method === "apply" ? "[{value:customCreate}]" : "{value:customCreate}"}]);`;
      expect(invocationKinds(source).invocations).not.toContainEqual(
        expect.objectContaining({
          kind: "known",
          path: ["intrinsic", "Object", "defineProperty"],
        }),
      );
      const result = analyzeJavaScriptStaticSource(
        `${source}\n${ROLLDOWN_MODULE_INTEROP}\n${WINDOW}`,
      );
      expect(result.electron.browser_windows).not.toEqual([]);
    },
  );

  it.each(["call", "apply"])(
    "keeps a detached bound %s member opaque",
    (method) => {
      const source = `const change = Object.defineProperty.bind(null,Object,"create");
      (0, change.${method})(null, ${method === "apply" ? "[{value:customCreate}]" : "{value:customCreate}"});`;
      expect(invocationKinds(source).invocations.at(-1)).toMatchObject({
        kind: "opaque",
        arguments: undefined,
      });
    },
  );

  it("models the write while the captured member's later read is unchanged", () => {
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const invoke = change.call;
      invoke.call(change,null,{value:customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
    expect(writes).toContainEqual(["intrinsic", "Object", "create"]);
  });

  it.each([
    ["call", "invoke.call(change,null,{value:customCreate});"],
    ["apply", "invoke.apply(change,[null,{value:customCreate}]);"],
  ])(
    "does not claim the intrinsic when Function.prototype.call.%s is replaced",
    (member, invoke) => {
      // `invoke` captured Function.prototype.call at its initializer, but
      // `invoke.call` is a fresh property read at the call site: after
      // `Function.prototype.call.call` is replaced the invoked value is the
      // replacement, so no confirmed defineProperty write exists.
      const { invocations, writes } = collectedWrites(
        `const change = Object.defineProperty.bind(null,Object,"create");
        const invoke = change.call;
        Function.prototype.call.${member} = replacement;
        ${invoke}`,
      );
      expect(invocations.at(-1)).toEqual(
        expect.objectContaining({ kind: "opaque" }),
      );
      expect(writes).not.toContainEqual(["intrinsic", "Object", "create"]);
      expect(writes).toContainEqual(["intrinsic"]);
    },
  );

  it.each([
    ["call", "invoke.call(change,null,{value:customCreate});"],
    ["apply", "invoke.apply(change,[null,{value:customCreate}]);"],
  ])(
    "reads a member replaced through the captured function's alias: %s",
    (member, invoke) => {
      // `invoke` IS Function.prototype.call, so `invoke.${member}` names the
      // same property slot as `Function.prototype.call.${member}` — a write
      // through the alias must reach the captured-member identity the read
      // side checks.
      const { invocations, writes } = collectedWrites(
        `const change = Object.defineProperty.bind(null,Object,"create");
        const invoke = change.call;
        invoke.${member} = replacement;
        ${invoke}`,
      );
      expect(writes).toContainEqual([
        "intrinsic",
        "Function",
        "prototype",
        "call",
        member,
      ]);
      expect(invocations.at(-1)).toEqual(
        expect.objectContaining({ kind: "opaque" }),
      );
      expect(writes).not.toContainEqual(["intrinsic", "Object", "create"]);
    },
  );

  it("retains argument effects when the outer member read is replaced", () => {
    // The argument's own write is recorded even though the replaced outer
    // member makes the invocation itself unknown.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const invoke = change.call;
      Function.prototype.call.call = replacement;
      invoke.call(change,null,(Object.create = customCreate, {value:1}));`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({ kind: "opaque" }),
    );
    expect(
      writes.filter(
        (path) =>
          path.length === 3 &&
          path[0] === "intrinsic" &&
          path[1] === "Object" &&
          path[2] === "create",
      ),
    ).toHaveLength(1);
  });

  it.each([
    'const change = Object.defineProperty.call; change(null,Object,"create",{value:customCreate});',
    'const {apply:change} = Object.defineProperty; change(null,[Object,"create",{value:customCreate}]);',
    'const change = Reflect.apply.call; change(null,Object.defineProperty,null,[Object,"create",{value:customCreate}]);',
  ])(
    "keeps a bare invocation member alias unknown, not effect-free: %s",
    (source) => {
      // `change` IS Function.prototype.call/apply read through an intrinsic.
      // Invoked bare it has no callable receiver, so a real engine throws
      // TypeError and no property write runs. Static analysis cannot prove
      // that receiver, so the invocation stays unknown rather than either
      // an effect-free call or a confirmed write.
      expect(invocationKinds(source).invocations).toEqual([
        expect.objectContaining({ kind: "opaque" }),
      ]);
      const result = analyzeJavaScriptStaticSource(
        `${source}\n${ROLLDOWN_MODULE_INTEROP}\n${WINDOW}`,
      );
      expect(result.electron.browser_windows).toEqual([]);
    },
  );

  it.each([
    'const change = Object.defineProperty.call; change.call(Object.defineProperty,null,Object,"create",{value:customCreate});',
    'Function.prototype.call.call(Object.defineProperty,null,Object,"create",{value:customCreate});',
    '(0, Object.defineProperty)(Object,"create",{value:customCreate});',
  ])("resolves an invocation that names a callable receiver: %s", (source) => {
    // Same invocation member reads, but the callable receiver is named.
    // These resolve to a known defineProperty write on Object.create.
    expect(invocationKinds(source).invocations).toEqual([
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    ]);
    const result = analyzeJavaScriptStaticSource(
      `${source}\n${ROLLDOWN_MODULE_INTEROP}\n${WINDOW}`,
    );
    expect(result.electron.browser_windows).toEqual([]);
  });

  it.each([
    '(0, Object.defineProperty.call)(null,metadata,"x",{value:1});',
    '(0, Object.defineProperty.apply)(null,[metadata,"x",{value:1}]);',
  ])("does not reconstruct a receiver erased by a sequence: %s", (source) => {
    expect(
      invocationKinds(`const metadata = {}; ${source}`).invocations,
    ).toEqual([expect.objectContaining({ kind: "opaque" })]);
  });
});

describe("intrinsic invocation member effects", () => {
  it("retains a converted Electron window evaluated inside an opaque invocation's arguments", () => {
    const result = analyzeJavaScriptStaticSource(`
      ${ROLLDOWN_MODULE_INTEROP}
      const change = Object.defineProperty.call;
      change(null, Object, "x", {value: new (__toESM(require("electron"), 1)).BrowserWindow({})});
    `);
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it("preserves a captured base through an invocation alias after global replacement", () => {
    const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      Object.defineProperty = replacement;
      const change = define.call;
      const metadata = {}; change.call(define,null,metadata,"x",{value:1});
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it("limits a known invocation effect to its fresh target", () => {
    const source =
      'const metadata = {}; Object.defineProperty.call(null,metadata,"x",{value:1});';
    expect(invocationKinds(source).invocations).toEqual([
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    ]);
    const result = analyzeJavaScriptStaticSource(
      `${source}\n${ROLLDOWN_MODULE_INTEROP}\n${WINDOW}`,
    );
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it("keeps a replaced invocation member read unknown", () => {
    const source = `Object.defineProperty.call = replacement;
      const change = Object.defineProperty.call;
      change.call(Object.defineProperty,null,Object,"create",{value:customCreate});`;
    const { interop, invocations, parsed } = invocationKinds(source);
    // Before the visible member write is retained the same call names a
    // callable receiver and resolves to a known defineProperty invocation.
    expect(invocations).toEqual([
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    ]);
    // Retaining the member write marks the captured read changed: the alias
    // can hold the replacement, so the same call stays unknown.
    let replaced = false;
    traverseJavaScriptAst(parsed.program, {
      enter: (node) => {
        if (
          !replaced &&
          t.isAssignmentExpression(node) &&
          t.isMemberExpression(node.left) &&
          t.isIdentifier(node.left.property, { name: "call" })
        ) {
          interop.retainWrite(node, [
            "intrinsic",
            "Object",
            "defineProperty",
            "call",
          ]);
          replaced = true;
        }
      },
    });
    expect(replaced).toBe(true);
    const call = parsed.program.body
      .filter(t.isExpressionStatement)
      .map((statement) => statement.expression)
      .find(
        (expression): expression is t.CallExpression =>
          t.isCallExpression(expression) &&
          t.isMemberExpression(expression.callee),
      );
    expect(interop.intrinsicInvocation(call!)).toEqual(
      expect.objectContaining({ kind: "opaque" }),
    );
    const result = analyzeJavaScriptStaticSource(
      `${source}\n${ROLLDOWN_MODULE_INTEROP}\n${WINDOW}`,
    );
    expect(result.electron.browser_windows).toEqual([]);
  });

  it.each([
    'const change = Object.defineProperty.call; change((Object.create = replacement, null),Object,"create",{value:customCreate});',
    'const {apply:change} = Object.defineProperty; change(null,[(Object.defineProperty = replacement, Object),"create",{value:customCreate}]);',
  ])(
    "records argument effects before an unknown invocation throws: %s",
    (source) => {
      // A real engine evaluates the arguments first: the intrinsic write in
      // the argument runs even though the bare alias call then throws. The
      // argument effect must be retained alongside the unknown call effect.
      expect(invocationKinds(source).invocations).toEqual([
        expect.objectContaining({ kind: "opaque" }),
      ]);
      const result = analyzeJavaScriptStaticSource(
        `${source}\n${ROLLDOWN_MODULE_INTEROP}\n${WINDOW}`,
      );
      expect(result.electron.browser_windows).toEqual([]);
    },
  );

  it("examines findings inside an opaque invocation argument", () => {
    const result = analyzeJavaScriptStaticSource(`
      const change = Object.defineProperty.call;
      change(null,Object,"create",{value:new (require("electron").BrowserWindow)({})});
    `);
    expect(result.electron.browser_windows).toHaveLength(1);
  });
});
