import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

// esbuild emits this CommonJS `require` shim for a Node/Electron target: the
// IIFE selects the host `require` when it exists and otherwise returns the
// passed fallback. Because the minifier renames `require` to a single letter,
// a bundled `require("electron")` becomes `Q("electron")` and is invisible to
// the direct-require resolver. The shape has been stable since esbuild 0.12.x:
//
//   var Q = (e => typeof require < "u" ? require : typeof Proxy < "u"
//     ? new Proxy(e, { get: (t, n) => (typeof require < "u" ? require : t)[n] })
//     : e)(function (e) {
//       if (typeof require < "u") return require.apply(this, arguments);
//       throw Error('Dynamic require of "' + e + '" is not supported');
//     });
const SHIM =
  'var Q=(e=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(e,{get:(t,n)=>(typeof require<"u"?require:t)[n]}):e)' +
  '(function(e){if(typeof require<"u")return require.apply(this,arguments);' +
  "throw Error('Dynamic require of \"'+e+'\" is not supported')});";

const CONSUMER =
  'var cy=Q("electron");new cy.BrowserWindow({webPreferences:{preload:"./preload.js",contextIsolation:!1}});cy.ipcMain.handle("get-version",()=>"1");';

const electronOf = (source: string) =>
  analyzeJavaScriptStaticSource(source).electron;

describe("Electron identity through esbuild's __require shim", () => {
  it("follows a bracketed require alias produced by esbuild", () => {
    const electron = electronOf(SHIM + CONSUMER);
    expect(electron.browser_windows).toMatchObject([
      { preload_path: "./preload.js" },
    ]);
    expect(electron.ipc).toMatchObject([
      { channel: "get-version", side: "main" },
    ]);
  });

  it("follows a member read from the shim call", () => {
    expect(
      electronOf(
        SHIM +
          'new (Q("electron").BrowserWindow)({webPreferences:{preload:"./p.js"}});',
      ).browser_windows,
    ).toMatchObject([{ preload_path: "./p.js" }]);
  });

  it("follows the shim when the availability test is written out", () => {
    const electron = electronOf(
      'var Q=(e=>typeof require!=="undefined"?require:e)(function(e){throw e});' +
        'new (Q("electron").BrowserWindow)({webPreferences:{preload:"./u.js"}});',
    );
    expect(electron.browser_windows).toMatchObject([
      { preload_path: "./u.js" },
    ]);
  });

  it.each([
    [
      "a shim binding reassigned before the call",
      `${SHIM}Q=other;var cy=Q("electron");new cy.BrowserWindow({});`,
    ],
    [
      "a shim whose guard always returns the fallback",
      'var Q=(e=>false?require:e)(other);var cy=Q("electron");new cy.BrowserWindow({});',
    ],
    [
      "a shim whose guard selects something other than require",
      'var Q=(e=>typeof require<"u"?other:e)(other);var cy=Q("electron");new cy.BrowserWindow({});',
    ],
    [
      "a locally defined require in the shim",
      'var require=x=>x;var Q=(e=>typeof require<"u"?require:e)(function(e){return require(e)});var cy=Q("electron");new cy.BrowserWindow({});',
    ],
    [
      "a non-IIFE loader-shaped binding",
      'var Q=other;var cy=Q("electron");new cy.BrowserWindow({});',
    ],
    [
      "a dynamic specifier through the shim",
      `${SHIM}var cy=Q(name);new cy.BrowserWindow({});`,
    ],
    [
      "a shim call whose argument is not a string literal",
      `${SHIM}var cy=Q("electron"+suffix);new cy.BrowserWindow({});`,
    ],
    [
      "a destructured projection of the shim result",
      'var {notTheLoader: Q}=(e=>typeof require<"u"?require:e)(function(e){throw e});var cy=Q("electron");new cy.BrowserWindow({});',
    ],
    [
      "a defaulted destructured projection of the shim result",
      'var {loader: Q=other}=(e=>typeof require<"u"?require:e)(function(e){throw e});var cy=Q("electron");new cy.BrowserWindow({});',
    ],
    [
      "a replaced module require before the shim",
      `require=mockLoader;${SHIM}var cy=Q("electron");new cy.BrowserWindow({});`,
    ],
    [
      "a module require replaced after the shim and before the load",
      `${SHIM}module.require=mockLoader;var cy=Q("electron");new cy.BrowserWindow({});`,
    ],
  ])("keeps %s unresolved", (_name, source) => {
    expect(electronOf(source).browser_windows).toEqual([]);
  });

  it("does not follow a require shadowed around a proven shim", () => {
    // The sibling `require` is a local function in the enclosing scope, so the
    // guard's `typeof require < "u"` is not the host availability test and the
    // shim must not alias the host loader.
    const source =
      "function f(require){" +
      'var Q=(e=>typeof require<"u"?require:e)(function(e){return require(e)});' +
      'var cy=Q("electron");new cy.BrowserWindow({});}';
    expect(electronOf(source).browser_windows).toEqual([]);
  });
});
