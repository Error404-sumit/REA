import {
  DOMParser,
  normalizeLineEndings,
  type Document,
  type Node,
} from "@xmldom/xmldom";
import { parse } from "plist";

import {
  createPlistNumberCollector,
  type PlistNumberLiterals,
} from "./apple/plistNumbers.js";

import { MAX_PLIST_DEPTH } from "./apple/plistValue.js";

/** The dictionary key REA results cannot carry: validation strips it. */
const PROTOTYPE_KEY = "__proto__";

/** A decoded plist without `__proto__` entries, and how many were omitted. */
export interface PropertyListWithoutPrototypeKeys {
  readonly value: unknown;
  readonly omittedPrototypeKeys: number;
}

/** Limitation for results whose source plist held `__proto__` entries. */
export const omittedPrototypeKeysLimitation = (count: number | null): string =>
  count === null
    ? "Dictionary entries keyed __proto__ were omitted because REA results cannot represent that key."
    : `${String(count)} dictionary ${count === 1 ? "entry" : "entries"} keyed __proto__ ${count === 1 ? "was" : "were"} omitted because REA results cannot represent that key.`;

const withoutKey = (
  value: unknown,
  key: string,
): PropertyListWithoutPrototypeKeys => {
  let omitted = 0;
  const strip = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(strip);
    if (
      item === null ||
      typeof item !== "object" ||
      item instanceof Date ||
      item instanceof Uint8Array
    )
      return item;
    return Object.fromEntries(
      Object.entries(item).flatMap(([name, entry]) => {
        if (name !== key) return [[name, strip(entry)]];
        omitted += 1;
        return [];
      }),
    );
  };
  const stripped = strip(value);
  return { value: stripped, omittedPrototypeKeys: omitted };
};

/** Remove own `__proto__` entries, such as JSON.parse creates, and count them. */
export const omitPrototypeKeys = (
  value: unknown,
): PropertyListWithoutPrototypeKeys => withoutKey(value, PROTOTYPE_KEY);

/**
 * Decode an XML plist whose dictionaries may use the legal key `__proto__`,
 * which the `plist` decoder rejects outright. Those entries are omitted and
 * counted so callers can report them instead of failing the whole document.
 * Real character data and number metadata share the same parsed XML facts.
 */
export const parseXmlPropertyList = (
  text: string,
): PropertyListWithoutPrototypeKeys & {
  readonly numberLiterals: PlistNumberLiterals;
} => {
  // Preserve the pinned decoder's existing OpenStep autodetection, also used
  // by app Info.plist resolution. Only XML needs decoder normalization.
  const first = text.trimStart()[0];
  if (first === "{" || first === "(") {
    assertOpenStepDepthWithinLimit(text);
    return {
      ...omitPrototypeKeys(parse(text)),
      numberLiterals: createPlistNumberCollector().result(),
    };
  }
  // Preserve character references: serializing the DOM would normalize them again.
  const normalized = normalizeLineEndings(text);
  const document = new DOMParser().parseFromString(normalized, "text/xml");
  const { numberLiterals, realCdata } = inspectXmlPropertyList(document);
  const { substituted, placeholder } = normalizeXmlDecoderInput(
    normalized,
    document,
    realCdata,
  );
  return { ...withoutKey(parse(substituted), placeholder), numberLiterals };
};

interface OpenStepContainer {
  end: string;
  next: "key" | "equals" | "value" | "separator" | "after-value";
}

/** Consume only the punctuation expected between the pinned decoder's values. */
const consumeOpenStepSeparator = (
  parent: OpenStepContainer | undefined,
  character: string,
): "consumed" | "invalid" | "none" => {
  if (parent?.next === "after-value") {
    parent.next = "key";
    return character === ";" ? "consumed" : "none";
  }
  if (parent?.next !== "equals" && parent?.next !== "separator") return "none";
  if (character !== (parent.next === "equals" ? "=" : ",")) return "invalid";
  parent.next = "value";
  return "consumed";
};

/** An array may close after a comma; a dictionary still needs its assigned value. */
const admitsOpenStepCloser = (
  parent: OpenStepContainer | undefined,
  character: string,
): boolean =>
  parent?.end === character &&
  parent.next !== "equals" &&
  !(parent.end === "}" && parent.next === "value");

/** Bound OpenStep value nesting before the pinned decoder recursively reads it. */
const assertOpenStepDepthWithinLimit = (text: string): void => {
  const containers: OpenStepContainer[] = [];
  const completeValue = (): void => {
    const parent = containers.at(-1);
    if (parent !== undefined)
      parent.next =
        parent.next === "key"
          ? "equals"
          : parent.end === "}"
            ? "after-value"
            : "separator";
  };
  const assertDepth = (): void => {
    if (containers.length > MAX_PLIST_DEPTH)
      throw new RangeError(
        `Plist exceeds ${String(MAX_PLIST_DEPTH)} nesting levels`,
      );
  };
  let cursor = 0;
  while (cursor < text.length) {
    const afterTrivia = skipOpenStepTrivia(text, cursor);
    if (afterTrivia !== cursor) {
      cursor = afterTrivia;
      continue;
    }
    const character = text[cursor] ?? "";
    const parent = containers.at(-1);
    // Stop at the first impossible token: only the pinned decoder owns syntax
    // diagnostics. A later deep suffix cannot change that failure into a limit.
    if (character === "}" || character === ")") {
      if (!admitsOpenStepCloser(parent, character)) return;
      containers.pop();
      // parseOpenStep returns the first root value without reading trailing text.
      if (containers.length === 0) return;
      completeValue();
      cursor += 1;
      continue;
    }
    const separator = consumeOpenStepSeparator(parent, character);
    if (separator === "invalid") return;
    if (separator === "consumed") {
      cursor += 1;
      continue;
    }
    if (character === "{" || character === "(") {
      assertDepth();
      containers.push({
        end: character === "{" ? "}" : ")",
        next: character === "{" ? "key" : "value",
      });
      cursor += 1;
      continue;
    }
    const end = skipOpenStepScalar(text, cursor);
    if (end === cursor) return;
    if (parent?.next !== "key") assertDepth();
    cursor = end;
    completeValue();
  }
};

/** Skip grammar trivia without interpreting delimiter examples inside comments. */
const skipOpenStepTrivia = (text: string, cursor: number): number => {
  if (/\s/u.test(text[cursor] ?? "")) return cursor + 1;
  if (!text.startsWith("//", cursor) && !text.startsWith("/*", cursor))
    return cursor;
  const line = text[cursor + 1] === "/";
  const end = text.indexOf(line ? "\n" : "*/", cursor + 2);
  return end === -1 ? text.length : end + (line ? 1 : 2);
};

/** Read the extent of one opaque scalar; the pinned decoder still owns its value. */
const skipOpenStepScalar = (text: string, start: number): number => {
  let cursor = start;
  const character = text[cursor];
  if (character === '"') {
    cursor += 1;
    while (cursor < text.length) {
      const next = text[cursor];
      cursor += next === "\\" ? 2 : 1;
      if (next === '"') break;
    }
  } else if (character === "<") {
    const end = text.indexOf(">", cursor + 1);
    cursor = end === -1 ? text.length : end + 1;
  } else {
    // Match the pinned OpenStep decoder's unquoted-string alphabet. Other
    // syntax remains for the decoder to reject; preflight only owns depth.
    while (
      cursor < text.length &&
      /[a-zA-Z0-9._/$:-]/u.test(text[cursor] ?? "")
    )
      cursor += 1;
  }
  return cursor;
};

/** Elements whose children the pinned plist value decoder visits recursively. */
const PLIST_CONTAINER_ELEMENTS = new Set(["plist", "dict", "array"]);

/**
 * Reject XML plists nested deeper than the projection supports before any
 * recursive value pass runs. `plist` and the prototype-key traversal recurse once
 * per nesting level, so a deeply nested document exhausts the call stack
 * before the projection limit can report the resource bound. The failure
 * matches `projectPlistValue` so callers classify it as a limit failure.
 *
 * Depth counts values the way the projection does: the root value is level 0
 * and every container member is one level deeper. A dictionary key names a
 * member instead of nesting one, and a self-closing element is the value at
 * its own level. The outer plist envelope is unwrapped by the decoder;
 * nested plist elements decode as arrays and must count toward the bound.
 */
const inspectXmlPropertyList = (document: Document) => {
  const numbers = createPlistNumberCollector();
  const realCdata: Node[] = [];
  const root = document.documentElement;
  const pending: Array<{ node: Node; depth: number }> =
    root === null ? [] : [{ node: root, depth: -1 }];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) break;
    const { node, depth } = entry;
    // Schedule only the next sibling, keeping traversal storage proportional
    // to depth rather than the number of members in a wide container.
    if (node.nextSibling !== null)
      pending.push({ node: node.nextSibling, depth });
    if (node.nodeType !== node.ELEMENT_NODE) continue;
    if (node.nodeName !== "key" && depth > MAX_PLIST_DEPTH)
      throw new RangeError(
        `Plist exceeds ${String(MAX_PLIST_DEPTH)} nesting levels`,
      );
    if (node.nodeName === "integer") {
      const child = node.firstChild;
      if (child?.nodeType === node.TEXT_NODE && child.nextSibling === null)
        numbers.integer((child.nodeValue ?? "").trim());
      else numbers.markIncomplete();
    } else if (node.nodeName === "real") {
      let text = "";
      let complete = true;
      const cdata: Node[] = [];
      for (
        let child = node.firstChild;
        child !== null;
        child = child.nextSibling
      ) {
        if (
          child.nodeType === node.TEXT_NODE ||
          child.nodeType === node.CDATA_SECTION_NODE
        ) {
          text += child.nodeValue ?? "";
          if (child.nodeType === node.CDATA_SECTION_NODE) cdata.push(child);
        } else if (child.nodeType !== node.COMMENT_NODE) complete = false;
      }
      if (complete) {
        numbers.real(Number.parseFloat(text));
        for (const child of cdata) realCdata.push(child);
      } else numbers.markIncomplete();
    }
    if (PLIST_CONTAINER_ELEMENTS.has(node.nodeName) && node.firstChild !== null)
      pending.push({ node: node.firstChild, depth: depth + 1 });
  }
  return { numberLiterals: numbers.result(), realCdata };
};

/** Normalize decoder divergences at their XML-owned source locations. */
const normalizeXmlDecoderInput = (
  text: string,
  document: Document,
  realCdata: readonly Node[],
) => {
  const keys = Array.from(document.getElementsByTagName("key"));
  const decodedKeys = new Set(keys.map((key) => key.firstChild?.nodeValue));
  let placeholder = "__rea_prototype_key__";
  while (decodedKeys.has(placeholder)) placeholder = `_${placeholder}`;

  const substitutions = [
    ...keys.flatMap((key) =>
      key.firstChild?.nodeValue === PROTOTYPE_KEY
        ? [
            {
              node: key.firstChild,
              replacement: `<![CDATA[${placeholder}]]>`,
              replaceCdata: false,
            },
          ]
        : [],
    ),
    ...realCdata.map((node) => ({
      node,
      replacement: (node.nodeValue ?? "").replace(
        /[&<>\r]/gu,
        (character) => `&#${String(character.charCodeAt(0))};`,
      ),
      replaceCdata: true,
    })),
  ].sort(
    (a, b) =>
      (a.node.lineNumber ?? 0) - (b.node.lineNumber ?? 0) ||
      (a.node.columnNumber ?? 0) - (b.node.columnNumber ?? 0),
  );
  if (substitutions.length === 0) return { substituted: text, placeholder };

  // xmldom uses one-based locators in document order. Scan forward only to
  // needed lines instead of retaining an offset for every source newline.
  let line = 1;
  let lineStart = 0;
  const parts: string[] = [];
  let cursor = 0;
  for (const { node, replacement, replaceCdata } of substitutions) {
    const nodeLine = node.lineNumber;
    const column = node.columnNumber;
    if (nodeLine === undefined || column === undefined)
      throw new TypeError("XML plist value has no source location");
    while (line < nodeLine) {
      const newline = text.indexOf("\n", lineStart);
      if (newline === -1)
        throw new TypeError("XML plist value has an invalid source location");
      lineStart = newline + 1;
      line += 1;
    }
    const offset = lineStart + column - 1;
    parts.push(text.slice(cursor, offset), replacement);
    cursor = offset;
    if (replaceCdata) {
      const end = text.indexOf("]]>", offset + 9);
      if (!text.startsWith("<![CDATA[", offset) || end < 0)
        throw new TypeError("XML plist CDATA has an invalid source location");
      cursor = end + 3;
    }
  }
  parts.push(text.slice(cursor));
  return { substituted: parts.join(""), placeholder };
};
