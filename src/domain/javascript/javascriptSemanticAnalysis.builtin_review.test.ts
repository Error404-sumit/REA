import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

it.each([
  "Object.assign(module, { [key]: replacement });",
  "Object.assign(module, { ...replacement });",
  "Object.assign(module, { require() {} });",
  "Object.defineProperties(module, { [key]: { value: replacement } });",
  "Reflect.set(module, 'require', replacement);",
  "Reflect.set(module, key, replacement);",
  "let owner=module; owner.require=replacement; owner={};",
])("invalidates the wrapper loader at its write: %s", (write) => {
  const ir = analyzeJavaScriptSemantics(`${write}
    const fs=require('fs'); fs.readFileSync('wrong');`);
  expect(ir.configurationOperations).toEqual([]);
});

it.each([
  "Object.assign(module, { unrelated: replacement });",
  "Object.defineProperties(module, { unrelated: { value: replacement } });",
  "Reflect.set(module, 'unrelated', replacement);",
  "let owner=module; owner={}; owner.require=replacement;",
])("preserves the wrapper loader across unrelated writes: %s", (write) => {
  const ir = analyzeJavaScriptSemantics(`${write}
    const fs=require('fs'); fs.readFileSync('kept');`);
  expect(ir.configurationOperations.map(({ key }) => key)).toEqual(["kept"]);
});

it.each(["globalThis", "global", "self", "window"])(
  "recognizes an unchanged qualified process receiver: %s",
  (global) => {
    const ir = analyzeJavaScriptSemantics(`${global}.process.cwd();
      const proc=require('process'); const mode=proc.env.MODE;`);
    expect(ir.configurationOperations.map(({ key }) => key)).toEqual(["MODE"]);
  },
);

it.each([
  "let fs=require('fs'); fs.readFileSync('kept'); fs={};",
  "let read=require('fs').readFileSync; read('kept'); read=custom;",
  "let proc=require('process'); const mode=proc.env.kept; proc={};",
  "const fs=require('fs'); fs.readFileSync('kept'); if(flag) { fs.readFileSync=custom; }",
  "const fs=require('fs'); if(flag) { fs.readFileSync('kept'); } fs.readFileSync=custom;",
  "const fs=require('fs'); { fs.readFileSync('kept'); } if(flag) { fs.readFileSync=custom; }",
])("retains a builtin read before a later effect: %s", (source) => {
  const ir = analyzeJavaScriptSemantics(source);
  expect(ir.configurationOperations.map(({ key }) => key)).toEqual(["kept"]);
});

it.each([
  "const fs=require('fs'); if(flag) { fs.readFileSync=custom; } fs.readFileSync('wrong');",
  "const fs=require('fs'); function later() { fs.readFileSync('wrong'); } fs.readFileSync=custom;",
  "const fs=require('fs'); for(;;) { fs.readFileSync('wrong'); fs.readFileSync=custom; }",
  "const fs=require('fs'); class C { value=fs.readFileSync('wrong'); } fs.readFileSync=custom;",
])("keeps conditional and delayed writes conservative: %s", (source) => {
  expect(analyzeJavaScriptSemantics(source).configurationOperations).toEqual(
    [],
  );
});

it.each([
  "statSync",
  "readdirSync",
  "mkdirSync",
  "accessSync",
  "lstatSync",
  "realpathSync",
])("does not escape the namespace through native fs.%s", (method) => {
  const ir =
    analyzeJavaScriptSemantics(`const fs=require('fs'); fs.${method}('probe');
      fs.readFileSync('kept');`);
  expect(ir.configurationOperations.map(({ key }) => key)).toEqual(["kept"]);
});

it.each(["stat", "readdir", "mkdir"])(
  "does not escape the namespace through native promises.%s",
  (method) => {
    const ir =
      analyzeJavaScriptSemantics(`const fs=require('fs/promises'); fs.${method}('probe');
      fs.open('kept');`);
    expect(ir.resourceOperations.map(({ method }) => method)).toEqual(["open"]);
  },
);

it("keeps a replaced native receiver uncertain", () => {
  const ir = analyzeJavaScriptSemantics(`const fs=require('fs');
    fs.statSync=custom; fs.statSync('probe'); fs.readFileSync('wrong');`);
  expect(ir.configurationOperations).toEqual([]);
});

it.each(["process", "proc"])(
  "retains scalar process reads passed to calls: %s",
  (receiver) => {
    const ir = analyzeJavaScriptSemantics(`const proc=require('process');
    const port=Number(${receiver}.env.PORT); consume(${receiver}.argv[2]);`);
    expect(ir.configurationOperations.map(({ key }) => key)).toEqual([
      "PORT",
      "2",
    ]);
  },
);

it("tracks process writes through self-reassigned global aliases", () => {
  const ir =
    analyzeJavaScriptSemantics(`let host=globalThis; host=host.globalThis;
    host.process.env={}; const proc=require('process'); const value=proc.env.MODE;`);
  expect(ir.configurationOperations).toEqual([]);
});

it.each(["key", "'__proto__'"])(
  "retains uncertainty when a required argv object escapes through %s",
  (key) => {
    const ir = analyzeJavaScriptSemantics(`const proc=require('node:process');
      function run() { patch(proc.argv[${key}]); return proc.argv[3]; }`);
    expect(ir.configurationOperations.map(({ key }) => key)).not.toContain("3");
  },
);

it("retains a nested builtin read before receiver reassignment", () => {
  const ir = analyzeJavaScriptSemantics(`let fs=require('fs');
    fs.promises.open('kept'); fs={};`);
  expect(ir.resourceOperations.map(({ method }) => method)).toEqual(["open"]);
});

it("checks the parent promises slot for fresh require chains", () => {
  const ir =
    analyzeJavaScriptSemantics(`const fs=require('fs'); delete fs.promises;
    require('fs').promises.open('wrong');`);
  expect(ir.resourceOperations).toEqual([]);
});

it.each([
  "const tls=require('tls'); const net=require('net');",
  "const tls=require('node:tls'); const net=require('node:net');",
  "import * as tls from 'node:tls'; import * as net from 'node:net';",
])("distinguishes TLS and net acquisition methods: %s", (imports) => {
  const ir = analyzeJavaScriptSemantics(`${imports}
    tls.connect(443); tls.createConnection(443);
    net.connect(80); net.createConnection(80);`);
  expect(ir.resourceOperations.map(({ method }) => method)).toEqual([
    "connect",
    "connect",
    "createConnection",
  ]);
});

it.each(["spawnSync", "execSync", "execFileSync"])(
  "retains asynchronous child effects alongside native %s",
  (method) => {
    const ir = analyzeJavaScriptSemantics(`const cp=require('child_process');
      function asyncRun() { return cp.spawn('tool'); }
      function syncRun() { return cp.${method}('tool'); }`);
    expect(ir.childProcessSpawns.map(({ method }) => method)).toEqual([
      "spawn",
    ]);
  },
);
