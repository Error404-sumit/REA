import { createHash, type Hash } from "node:crypto";
import { z } from "zod";
import type { JsonValue } from "../jsonValue.js";
import { asciiLowercase } from "../asciiLowercase.js";
import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";
import type { WebNetworkCaptureRecord } from "../webNetworkCapture.js";

export const REQUEST_HEADER_SCOPES = ["script-settable", "all"] as const;
export type RequestHeaderScope = (typeof REQUEST_HEADER_SCOPES)[number];

const ALPHABETS = ["decimal", "hex", "base64url", "base64", "other"] as const;
// Character-repertoire rules apply in order; a match is not a decoding claim.
const ALPHABET_RULES = [
  /^[0-9]+$/u,
  /^[0-9A-Fa-f]+$/u,
  /^[A-Za-z0-9_-]+={0,2}$/u,
  /^[A-Za-z0-9+/]+={0,2}$/u,
] as const;
const DECIMAL = 1;
const OTHER = 1 << (ALPHABETS.length - 1);

// WHATWG Fetch forbidden request-header names. The value-dependent
// method-override rule is not applied, so those names remain listed.
const FORBIDDEN_REQUEST_HEADER_NAMES = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

/** Page script cannot set forbidden request-header names or HTTP/2 pseudo-headers. */
const scriptSettable = (name: string): boolean =>
  !name.startsWith(":") &&
  !name.startsWith("proxy-") &&
  !name.startsWith("sec-") &&
  !FORBIDDEN_REQUEST_HEADER_NAMES.has(name);

const ordinalsSchema = z.array(z.number().int().nonnegative());
const namesSchema = z.array(
  z.strictObject({ name: z.string(), record_ordinals: ordinalsSchema }),
);

/** Value-free request header and cookie name facets for one API-surface group. */
export const requestHeaderFacetsSchema = z.strictObject({
  scope: z.enum(REQUEST_HEADER_SCOPES),
  excluded_names: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Distinct recorded request header names omitted by the selected scope.",
    ),
  request_headers: z.array(
    z.strictObject({
      name: z.string().describe("ASCII-lowercased recorded field name."),
      present_records: z.number().int().positive(),
      redacted_records: z.number().int().nonnegative(),
      distinct_values: z
        .number()
        .int()
        .positive()
        .nullable()
        .describe(
          "Distinct per-record values; null when any present value was redacted or absent.",
        ),
      value_length: z
        .strictObject({
          min: z.number().int().nonnegative(),
          max: z.number().int().nonnegative(),
        })
        .nullable()
        .describe("UTF-16 code units of retained field values."),
      alphabets: z.array(z.enum(ALPHABETS)),
      variation: z.enum([
        "constant",
        "per-record-unique",
        "varying",
        "single-sample",
        "unknown",
      ]),
      inferences: z.array(
        z.strictObject({
          kind: z.enum([
            "per-request-token-candidate",
            "epoch-timestamp-candidate",
          ]),
          basis: z.literal("inferred"),
        }),
      ),
    }),
  ),
  unavailable_header_name_ordinals: ordinalsSchema,
  cookie_names: namesSchema,
  unavailable_cookie_name_ordinals: ordinalsSchema,
  set_cookie_names: namesSchema,
  unavailable_set_cookie_name_ordinals: ordinalsSchema,
});
type RequestHeaderFacets = z.output<typeof requestHeaderFacetsSchema>;
type HeaderRow = RequestHeaderFacets["request_headers"][number];

/** Representation allowances supplied by the accumulator that owns the budget. */
export interface RequestHeaderFacetCost {
  readonly entry: number;
  readonly container: number;
  readonly scratch: number;
  /** One retained in-memory value digest; digests are never serialized. */
  readonly digest: number;
  readonly text: (length: number) => number;
}

interface HeaderValue {
  /** Digest of the record's ordered field values; null when any is unavailable. */
  digest: string | null;
  redacted: boolean;
  minLength: number;
  maxLength: number;
  alphabets: number;
}

/** Per-record facts read in memory; values are never retained as text. */
export interface RecordHeaderFacts {
  readonly headers: ReadonlyMap<string, Readonly<HeaderValue>>;
  readonly excludedNames: ReadonlySet<string>;
  readonly headerNamesUnavailable: boolean;
  readonly cookieNames: ReadonlySet<string>;
  readonly cookieNamesUnavailable: boolean;
  readonly setCookieNames: ReadonlySet<string>;
  readonly setCookieNamesUnavailable: boolean;
}

type JsonObject = { readonly [key: string]: JsonValue };
const jsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fieldName = (value: unknown): string | undefined =>
  jsonObject(value) && typeof value.name === "string" ? value.name : undefined;
const HEADER_VALUE_POINTER = /^\/request\/headers\/(0|[1-9][0-9]*)\/value$/u;

const messages = (reported: JsonValue) => {
  const request = jsonObject(reported) ? reported.request : undefined;
  const response = jsonObject(reported) ? reported.response : undefined;
  return {
    request: jsonObject(request) ? request : undefined,
    response: jsonObject(response) ? response : undefined,
  };
};

/**
 * UTF-16 code units encoded per hash update. Values are borrowed from the
 * parent, so hashing in slices keeps the temporary encoding bounded instead of
 * proportional to a value's length.
 */
const HASH_CHUNK_CODE_UNITS = 1024;

/** Feed code units in bounded slices; each unit encodes independently, so splits are lossless. */
const updateUtf16 = (hash: Hash, text: string): void => {
  for (let start = 0; start < text.length; start += HASH_CHUNK_CODE_UNITS)
    hash.update(text.slice(start, start + HASH_CHUNK_CODE_UNITS), "utf16le");
};

/** Upper bound for per-record names, maps and value lists before any is created. */
export const recordHeaderScratchBytes = (
  record: WebNetworkCaptureRecord,
  cost: RequestHeaderFacetCost,
): number => {
  const { request, response } = messages(record.reported);
  // Fixed maps and sets, the one hash state live while digesting a name, and
  // that state's bounded slice and encoding. Borrowed values are not copied.
  let bytes =
    cost.scratch + cost.container * 7 + cost.text(HASH_CHUNK_CODE_UNITS);
  const lines = (value: JsonValue | undefined, perLine: number) => {
    if (!Array.isArray(value)) return;
    for (const line of value) {
      const name = fieldName(line);
      bytes += perLine + (name === undefined ? 0 : cost.text(name.length));
    }
  };
  // A name copy, a map entry, a value state and one borrowed value slot per line.
  lines(request?.headers, cost.entry * 3);
  lines(request?.cookies, cost.entry);
  lines(response?.headers, cost.entry);
  lines(response?.cookies, cost.entry);
  bytes += record.redactions.length * cost.entry;
  return bytes;
};

const recordNames = (
  value: JsonValue | undefined,
  emptyIsUnknown: boolean,
): { readonly names: Set<string>; readonly unavailable: boolean } => {
  const names = new Set<string>();
  if (!Array.isArray(value)) return { names, unavailable: true };
  let unavailable = value.length === 0 && emptyIsUnknown;
  for (const item of value) {
    const name = fieldName(item);
    if (name === undefined) unavailable = true;
    else names.add(name);
  }
  return { names, unavailable };
};

/** Read one grouped record after its scratch allowance has been admitted. */
export const readRecordHeaderFacts = (
  record: WebNetworkCaptureRecord,
  scope: RequestHeaderScope,
): RecordHeaderFacts => {
  const { request, response } = messages(record.reported);
  const headers = new Map<string, HeaderValue>();
  // Borrowed parent strings per name; null once any field value is unavailable.
  const values = new Map<string, string[] | null>();
  const excludedNames = new Set<string>();
  const lines = request?.headers;
  let headerNamesUnavailable = !Array.isArray(lines);
  let cookieHeader = false;
  if (Array.isArray(lines)) {
    // The producer's redaction sidecar owns which values were removed.
    const redacted = new Set<number>();
    for (const { pointer } of record.redactions) {
      const match = HEADER_VALUE_POINTER.exec(pointer);
      if (match !== null) redacted.add(Number(match[1]));
    }
    for (const [index, line] of lines.entries()) {
      const recorded = fieldName(line);
      if (recorded === undefined) {
        headerNamesUnavailable = true;
        continue;
      }
      const name = asciiLowercase(recorded);
      if (name === "cookie") cookieHeader = true;
      if (scope === "script-settable" && !scriptSettable(name)) {
        excludedNames.add(name);
        continue;
      }
      let value = headers.get(name);
      if (value === undefined) {
        value = {
          digest: null,
          redacted: false,
          minLength: Number.POSITIVE_INFINITY,
          maxLength: -1,
          alphabets: 0,
        };
        headers.set(name, value);
        values.set(name, []);
      }
      const text = jsonObject(line) ? line.value : undefined;
      if (redacted.has(index)) value.redacted = true;
      if (redacted.has(index) || typeof text !== "string") {
        values.set(name, null);
        continue;
      }
      value.minLength = Math.min(value.minLength, text.length);
      value.maxLength = Math.max(value.maxLength, text.length);
      const rule = ALPHABET_RULES.findIndex((pattern) => pattern.test(text));
      value.alphabets |= rule < 0 ? OTHER : 1 << rule;
      values.get(name)?.push(text);
    }
    // Hash one name at a time so a single hash state is live. Length-prefixed
    // UTF-16 code units keep ordered field values and lone surrogates distinct.
    for (const [name, texts] of values) {
      if (texts === null) continue;
      const hash = createHash("sha256");
      for (const text of texts) {
        hash.update(`${text.length}:`);
        updateUtf16(hash, text);
      }
      headers.get(name)!.digest = hash.digest("latin1");
    }
  }
  const cookies = recordNames(
    request?.cookies,
    cookieHeader || headerNamesUnavailable,
  );
  let setCookieHeader = false;
  let responseHeadersUnavailable = !Array.isArray(response?.headers);
  if (Array.isArray(response?.headers))
    for (const line of response.headers) {
      const name = fieldName(line);
      if (name === undefined) responseHeadersUnavailable = true;
      else if (asciiLowercase(name) === "set-cookie") setCookieHeader = true;
    }
  const setCookies =
    response === undefined
      ? { names: new Set<string>(), unavailable: true }
      : recordNames(
          response.cookies,
          setCookieHeader || responseHeadersUnavailable,
        );
  return {
    headers,
    excludedNames,
    headerNamesUnavailable,
    cookieNames: cookies.names,
    cookieNamesUnavailable: cookies.unavailable,
    setCookieNames: setCookies.names,
    setCookieNamesUnavailable: setCookies.unavailable,
  };
};

interface RowState {
  presentRecords: number;
  redactedRecords: number;
  /** Undefined once any present value is unavailable; distinct count is then unknown. */
  digests: Set<string> | undefined;
  minLength: number;
  maxLength: number;
  alphabets: number;
}

const appendNamed = (
  target: Map<string, number[]>,
  names: ReadonlySet<string>,
  ordinal: number,
): void => {
  for (const name of names) {
    const ordinals = target.get(name);
    if (ordinals === undefined) target.set(name, [ordinal]);
    else ordinals.push(ordinal);
  }
};

const projectNamed = (
  source: ReadonlyMap<string, readonly number[]>,
): RequestHeaderFacets["cookie_names"] =>
  [...source]
    .sort(([a], [b]) => compare(a, b))
    .map(([name, record_ordinals]) => ({
      name,
      record_ordinals: [...record_ordinals],
    }));

const variation = (
  present: number,
  distinct: number | null,
): HeaderRow["variation"] => {
  if (distinct === null) return "unknown";
  if (present === 1) return "single-sample";
  if (distinct === 1) return "constant";
  return distinct === present ? "per-record-unique" : "varying";
};

// Fewer samples cannot distinguish per-request variation from coincidence.
const MIN_INFERENCE_RECORDS = 3;

/** Fixed value-shape rules; header names never select or suppress a rule. */
const inferences = (row: RowState, distinct: number | null) => {
  const result: HeaderRow["inferences"] = [];
  if (distinct === null || row.presentRecords < MIN_INFERENCE_RECORDS)
    return result;
  if (
    distinct === row.presentRecords &&
    row.minLength >= 16 &&
    (row.alphabets & OTHER) === 0 &&
    row.alphabets !== DECIMAL
  )
    result.push({ kind: "per-request-token-candidate", basis: "inferred" });
  if (
    distinct > 1 &&
    row.alphabets === DECIMAL &&
    row.minLength === row.maxLength &&
    (row.minLength === 10 || row.minLength === 13)
  )
    result.push({ kind: "epoch-timestamp-candidate", basis: "inferred" });
  return result;
};

/** Own one group's header rows, digests and cookie names under admitted charges. */
export class RequestHeaderFacetCollector {
  readonly #rows = new Map<string, RowState>();
  readonly #excludedNames = new Set<string>();
  readonly #unavailableHeaderNames: number[] = [];
  readonly #cookieNames = new Map<string, number[]>();
  readonly #unavailableCookieNames: number[] = [];
  readonly #setCookieNames = new Map<string, number[]>();
  readonly #unavailableSetCookieNames: number[] = [];

  constructor(readonly scope: RequestHeaderScope) {}

  /** Retained and projected bytes for merging one record, including a new collector. */
  static admissionBytes(
    facts: RecordHeaderFacts,
    collector: RequestHeaderFacetCollector | undefined,
    cost: RequestHeaderFacetCost,
  ): number {
    const retained =
      collector === undefined
        ? undefined
        : {
            rows: collector.#rows,
            excludedNames: collector.#excludedNames,
            cookieNames: collector.#cookieNames,
            setCookieNames: collector.#setCookieNames,
          };
    let bytes = retained === undefined ? cost.container * 8 : 0;
    for (const [name, value] of facts.headers) {
      const row = retained?.rows.get(name);
      if (row === undefined)
        bytes +=
          cost.container * 2 +
          cost.entry +
          cost.text(name.length) +
          (value.digest === null ? 0 : cost.digest);
      else if (
        row.digests !== undefined &&
        value.digest !== null &&
        !row.digests.has(value.digest)
      )
        bytes += cost.digest;
    }
    for (const name of facts.excludedNames)
      if (retained?.excludedNames.has(name) !== true)
        bytes += cost.entry + cost.text(name.length);
    const named = (
      names: ReadonlySet<string>,
      known: ReadonlyMap<string, readonly number[]> | undefined,
    ) => {
      for (const name of names)
        bytes +=
          cost.entry +
          (known?.has(name) === true ? 0 : cost.entry + cost.text(name.length));
    };
    named(facts.cookieNames, retained?.cookieNames);
    named(facts.setCookieNames, retained?.setCookieNames);
    for (const unavailable of [
      facts.headerNamesUnavailable,
      facts.cookieNamesUnavailable,
      facts.setCookieNamesUnavailable,
    ])
      if (unavailable) bytes += cost.entry;
    return bytes;
  }

  /** Apply an admitted record; no allocation here is uncharged. */
  add(facts: RecordHeaderFacts, ordinal: number): void {
    for (const [name, value] of facts.headers) {
      let row = this.#rows.get(name);
      if (row === undefined) {
        row = {
          presentRecords: 0,
          redactedRecords: 0,
          digests: new Set(),
          minLength: Number.POSITIVE_INFINITY,
          maxLength: -1,
          alphabets: 0,
        };
        this.#rows.set(name, row);
      }
      row.presentRecords += 1;
      if (value.redacted) row.redactedRecords += 1;
      if (value.digest === null) row.digests = undefined;
      else row.digests?.add(value.digest);
      row.minLength = Math.min(row.minLength, value.minLength);
      row.maxLength = Math.max(row.maxLength, value.maxLength);
      row.alphabets |= value.alphabets;
    }
    for (const name of facts.excludedNames) this.#excludedNames.add(name);
    if (facts.headerNamesUnavailable)
      this.#unavailableHeaderNames.push(ordinal);
    appendNamed(this.#cookieNames, facts.cookieNames, ordinal);
    if (facts.cookieNamesUnavailable)
      this.#unavailableCookieNames.push(ordinal);
    appendNamed(this.#setCookieNames, facts.setCookieNames, ordinal);
    if (facts.setCookieNamesUnavailable)
      this.#unavailableSetCookieNames.push(ordinal);
  }

  /** Whether any row would carry an inference; counted across the full grouping. */
  inferred(): boolean {
    for (const row of this.#rows.values())
      if (inferences(row, row.digests?.size ?? null).length > 0) return true;
    return false;
  }

  /** Derived counts and labelled inferences; values, prefixes and digests stay private. */
  project(): RequestHeaderFacets {
    return {
      scope: this.scope,
      excluded_names: this.#excludedNames.size,
      request_headers: [...this.#rows]
        .sort(([a], [b]) => compare(a, b))
        .map(([name, row]): HeaderRow => {
          const distinct = row.digests?.size ?? null;
          return {
            name,
            present_records: row.presentRecords,
            redacted_records: row.redactedRecords,
            distinct_values: distinct,
            value_length:
              row.maxLength < 0
                ? null
                : { min: row.minLength, max: row.maxLength },
            alphabets: ALPHABETS.filter(
              (_, index) => (row.alphabets & (1 << index)) !== 0,
            ),
            variation: variation(row.presentRecords, distinct),
            inferences: inferences(row, distinct),
          };
        }),
      unavailable_header_name_ordinals: [...this.#unavailableHeaderNames],
      cookie_names: projectNamed(this.#cookieNames),
      unavailable_cookie_name_ordinals: [...this.#unavailableCookieNames],
      set_cookie_names: projectNamed(this.#setCookieNames),
      unavailable_set_cookie_name_ordinals: [
        ...this.#unavailableSetCookieNames,
      ],
    };
  }
}
