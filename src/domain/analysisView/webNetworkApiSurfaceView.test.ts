import { createHash } from "node:crypto";
import { REQUEST_HEADER_FACET_VALUES } from "../../../tests/fixtures/historicalHar.js";
import { expect, it } from "vitest";
import {
  analysisViewCaptureFixture,
  analysisViewCaptureEvidence,
} from "../../../tests/fixtures/analysisView.js";
import { projectAnalysisView } from "./analysisView.js";

const project = (
  capture = analysisViewCaptureFixture(),
  offset = 0,
  limit = 50,
  parameters: unknown = { sensitive_value_count: 0 },
  includeQueryParameterNames?: boolean,
) => {
  const parent = analysisViewCaptureEvidence(capture);
  return projectAnalysisView(
    {
      evidenceId: parent.evidence_id,
      operation: parent.operation,
      normalizedResult: parent.normalized_result,
      limitations: [],
      parameters,
    },
    {
      kind: "api-surface",
      offset,
      limit,
      ...(includeQueryParameterNames === undefined
        ? {}
        : {
            include_query_parameter_names: includeQueryParameterNames,
          }),
    },
  );
};

it("selects query names without values, retains source ordinals and leaves default groups unchanged", () => {
  const capture = analysisViewCaptureFixture();
  capture.records = capture.records.slice(0, 3);
  capture.total_records = 3;
  const urls = [
    "https://api.test/products?category=books&page=1&category=repeat#fragment-only",
    "https://api.test/products?category=games&sort=price",
    "https://api.test/health",
  ];
  for (const [index, record] of capture.records.entries())
    record.reported = {
      request: { method: "GET", url: urls[index]! },
      response: { status: 200, content: { mimeType: "application/json" } },
    };
  const selected = project(capture, 0, 50, { sensitive_value_count: 0 }, true);
  const omitted = project(capture);
  const disabled = project(capture, 0, 50, { sensitive_value_count: 0 }, false);
  if (
    !selected.ok ||
    selected.value.kind !== "api-surface" ||
    !omitted.ok ||
    omitted.value.kind !== "api-surface" ||
    !disabled.ok ||
    disabled.value.kind !== "api-surface"
  )
    throw new Error("Expected surfaces");
  expect(disabled.value.groups).toEqual(omitted.value.groups);
  expect(selected.value.groups).toEqual([
    { ...omitted.value.groups[0], query_parameter_names: [] },
    {
      ...omitted.value.groups[1],
      query_parameter_names: [
        { name: "category", record_ordinals: [0, 1] },
        { name: "page", record_ordinals: [0] },
        { name: "sort", record_ordinals: [1] },
      ],
    },
  ]);
  for (const literal of ["books", "games", "repeat", "price", "fragment-only"])
    expect(JSON.stringify(selected.value)).not.toContain(literal);
  expect(selected.value.parent_evidence_id).toBe(
    omitted.value.parent_evidence_id,
  );
});

it("preserves decoded empty and Unicode query names, plus distinctions and caller ordinal order", () => {
  const capture = analysisViewCaptureFixture();
  capture.records = [capture.records[3]!, capture.records[1]!];
  const urls = [
    "https://api.test/a/%2e%2e/products?b=1&a+b=2&a%2Bb=3&=4&%E9%9B%AA=5&b=6&&%FF=7&__proto__=8#ignored=9",
    "https://api.test/a/%2e%2e/products?b=10",
  ];
  capture.records.forEach((record, index) => {
    record.reported = { request: { method: "GET", url: urls[index]! } };
  });
  const result = project(capture, 0, 1, { sensitive_value_count: 0 }, true);
  if (!result.ok || result.value.kind !== "api-surface")
    throw new Error("Expected surface");
  expect(result.value.groups[0]).toMatchObject({
    path_template: "/a/%2e%2e/products",
    record_ordinals: [3, 1],
    query_parameter_names: [
      { name: "", record_ordinals: [3] },
      { name: "__proto__", record_ordinals: [3] },
      { name: "a b", record_ordinals: [3] },
      { name: "a+b", record_ordinals: [3] },
      { name: "b", record_ordinals: [3, 1] },
      { name: "雪", record_ordinals: [3] },
      { name: "�", record_ordinals: [3] },
    ],
  });
  expect(result.value.records.total).toBe(15);
  expect(result.value.limitations.join(" ")).toContain("ordinal subset");
});

it("preserves sensitive-parent refusal when query names are selected", () => {
  expect(
    project(
      analysisViewCaptureFixture(),
      0,
      50,
      { sensitive_value_count: 1 },
      true,
    ),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisUnsupportedTargetError",
      reason: "sensitive_values_unretained",
    },
  });
});
it("groups only exact formats, preserves literal routes, excludes URLs and produces deterministic digests", () => {
  const result = project();
  if (!result.ok || result.value.kind !== "api-surface")
    throw new Error("Expected surface");
  expect(project()).toEqual(result);
  const surface = result.value;
  expect(surface.groups.map((group) => group.path_template)).toEqual([
    "/api/CreateDocument",
    "/api/ListDocuments",
    "/api/Report2",
    "/api/Report3",
    "/api/v1/users",
    "/api/v2/users",
    "/dates/2023-02-29",
    "/dates/{iso-date}",
    "/ids/abc123",
    "/ids/{hex}",
    "/ids/{uuid}",
    "/users/{numeric}",
  ]);
  expect(surface.groups.at(-1)).toMatchObject({
    record_ordinals: [0, 1],
    statuses: [200, 404],
    content_types: ["application/json", "text/plain"],
    flags: ["mixed-statuses", "mixed-content-types"],
    templated_segments: [
      {
        segment_index: 1,
        rule: "numeric",
        basis: "inferred",
        observed_values: ["8812", "9031"],
      },
    ],
  });
  expect(surface.excluded_records).toEqual([
    { ordinal: 13, reason: "url-redacted" },
    { ordinal: 14, reason: "url-unparseable" },
  ]);
  expect(JSON.stringify(surface)).not.toContain("not-in-view");
  expect(JSON.stringify(surface)).not.toContain("雪");
});
it("pages groups independently of record completeness and preserves null digests", () => {
  const capture = analysisViewCaptureFixture();
  capture.artifact.sha256 = null;
  capture.total_records = 30;
  const result = project(capture, 10, 2);
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    artifact: { sha256: null },
    coverage: { examined: 2, total: 12, exhausted: true, next_offset: null },
    records: { examined: 15, total: 30, excluded: 2 },
  });
  expect(result.value.limitations.join(" ")).toContain("ordinal subset");
  expect(project(capture, 50, 2)).toMatchObject({
    ok: true,
    value: {
      coverage: { status: "empty", exhausted: true, next_offset: null },
    },
  });
});
it("rejects native captures and malformed parents with typed errors", () => {
  const capture = analysisViewCaptureFixture();
  for (const format of ["mitmproxy", "saz"] as const) {
    capture.format = format;
    expect(project(capture)).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisUnsupportedTargetError" },
    });
  }
  expect(
    projectAnalysisView(
      {
        evidenceId: `ev_${"a".repeat(64)}`,
        operation: "inspect_web_network_capture",
        normalizedResult: {},
        limitations: [],
      },
      { kind: "api-surface", offset: 0, limit: 1 },
    ),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
});

it("preserves partial response facts and explains unavailable requests", () => {
  const capture = analysisViewCaptureFixture();
  capture.records = capture.records.slice(0, 5);
  const values = [
    {
      request: {
        method: "GET",
        url: "https://user:password@api.example.test/1/2?private=value",
      },
      response: { status: 200, content: null },
    },
    { request: { method: null, url: "https://api.example.test/" } },
    null,
    { request: { method: "GET", url: "data:text/plain,hello" } },
    {
      request: { method: "GET", url: "https://api.example.test/1/2" },
      response: { status: null, content: { mimeType: "application/json" } },
    },
  ];
  capture.records.forEach((record, index) => {
    record.reported = values[index] ?? null;
  });
  const result = project(capture);
  if (!result.ok || result.value.kind !== "api-surface")
    throw new Error("Expected surface");
  expect(result.value.groups).toMatchObject([
    {
      origin: "https://api.example.test",
      path_template: "/{numeric}/{numeric}",
      statuses: [200],
      content_types: ["application/json"],
      templated_segments: [
        { segment_index: 0, observed_values: ["1"] },
        { segment_index: 1, observed_values: ["2"] },
      ],
    },
  ]);
  expect(result.value.excluded_records).toEqual([
    { ordinal: 1, reason: "method-unavailable" },
    { ordinal: 2, reason: "request-unavailable" },
    { ordinal: 3, reason: "url-unparseable" },
  ]);
  expect(result.value.unknowns).not.toEqual([]);
  expect(JSON.stringify(result.value)).not.toContain("password");
  expect(JSON.stringify(result.value)).not.toContain("private");
});

it("keeps encoded segments literal and distinguishes origin and method", () => {
  const capture = analysisViewCaptureFixture();
  capture.records = capture.records.slice(0, 4);
  const urls = [
    "https://a.test/%31",
    "https://a.test/1",
    "https://b.test/1",
    "https://a.test/1",
  ];
  capture.records.forEach((record, index) => {
    record.reported = {
      request: { method: index === 3 ? "POST" : "GET", url: urls[index]! },
      response: {
        status: 200,
        content: { mimeType: "application/json; charset=utf-8" },
      },
    };
  });
  const result = project(capture, 0, 2);
  if (!result.ok || result.value.kind !== "api-surface")
    throw new Error("Expected surface");
  expect(result.value.coverage).toMatchObject({
    total: 4,
    next_offset: 2,
    exhausted: false,
  });
  expect(result.value.groups[0]?.path_template).toBe("/%31");
});

it("refuses parents whose sensitive declarations it cannot check", () => {
  for (const parameters of [{ sensitive_value_count: 1 }, {}, null]) {
    const result = project(analysisViewCaptureFixture(), 0, 50, parameters);
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisUnsupportedTargetError" },
    });
    if (result.ok) continue;
    expect(result.error).toMatchObject({
      reason: "sensitive_values_unretained",
    });
    expect(result.error.message).not.toContain("path templates");
  }
});

it("rejects cyclic captures and accessor members without invoking them", () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  let accessed = false;
  const accessor = {
    get records() {
      accessed = true;
      return [];
    },
  };
  const hiddenAccessor = Object.defineProperty({}, "records", {
    get() {
      accessed = true;
      return [];
    },
  });
  const inherited = Object.create({ records: [] }) as unknown;
  for (const normalizedResult of [cyclic, accessor, hiddenAccessor, inherited])
    expect(
      projectAnalysisView(
        {
          evidenceId: `ev_${"a".repeat(64)}`,
          operation: "inspect_web_network_capture",
          normalizedResult,
          limitations: [],
        },
        { kind: "api-surface", offset: 0, limit: 1 },
      ),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  expect(accessed).toBe(false);
});

it("treats HAR missing-response sentinels as unknown", () => {
  const capture = analysisViewCaptureFixture();
  capture.records = capture.records.slice(0, 1);
  capture.records[0]!.reported = {
    request: { method: "GET", url: "https://api.example.test/a" },
    response: { status: 0, content: { mimeType: " ; charset=utf-8" } },
  };
  const result = project(capture);
  if (!result.ok || result.value.kind !== "api-surface")
    throw new Error("Expected surface");
  expect(result.value.groups[0]).toMatchObject({
    statuses: [],
    content_types: [],
  });
  expect(result.value.unknowns).not.toEqual([]);
});

it("refuses a path whose templated representation exceeds projection capacity", () => {
  const capture = analysisViewCaptureFixture();
  capture.records = capture.records.slice(0, 1);
  capture.records[0]!.reported = {
    request: {
      method: "GET",
      url: `https://api.example.test${"/1".repeat(800_000)}`,
    },
  };
  expect(project(capture)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError" },
  });
});

it("scans highly segmented literal paths and keeps recorded dot segments", () => {
  const capture = analysisViewCaptureFixture();
  capture.records = capture.records.slice(0, 3);
  const urls = [
    `https://api.example.test${"/a".repeat(90_000)}`,
    "https://api.example.test/a/%2e%2e/admin",
    "https://api.example.test/admin",
  ];
  capture.records.forEach((record, index) => {
    record.reported = { request: { method: "GET", url: urls[index] ?? null } };
  });
  const result = project(capture);
  if (!result.ok || result.value.kind !== "api-surface")
    throw new Error("Expected surface");
  expect(result.value.groups.map((group) => group.path_template)).toEqual(
    expect.arrayContaining(["/a/%2e%2e/admin", "/admin"]),
  );
  expect(result.value.groups).toHaveLength(3);
});

it("excludes slashless URL spellings instead of reading their paths", () => {
  const capture = analysisViewCaptureFixture();
  capture.records = capture.records.slice(0, 4);
  const urls = [
    "https:user:pass@example.test/path",
    "https:123/456",
    "https:///user:pass@example.test/path",
    "https://\\user:pass@example.test/path",
  ];
  capture.records.forEach((record, index) => {
    record.reported = { request: { method: "GET", url: urls[index] ?? null } };
  });
  const result = project(capture);
  if (!result.ok || result.value.kind !== "api-surface")
    throw new Error("Expected surface");
  expect(result.value.groups).toEqual([]);
  expect(result.value.excluded_records).toEqual([
    { ordinal: 0, reason: "url-unparseable" },
    { ordinal: 1, reason: "url-unparseable" },
    { ordinal: 2, reason: "url-unparseable" },
    { ordinal: 3, reason: "url-unparseable" },
  ]);
  expect(JSON.stringify(result.value)).not.toContain("pass");
});

it("excludes control-only authorities instead of publishing their userinfo", () => {
  const capture = analysisViewCaptureFixture();
  capture.records = capture.records.slice(0, 3);
  const urls = [
    "https://\t/user:pass@example.test/path",
    "https://\n/user:pass@example.test/path",
    "https://\r/user:pass@example.test/path",
  ];
  capture.records.forEach((record, index) => {
    record.reported = { request: { method: "GET", url: urls[index] ?? null } };
  });
  const result = project(capture);
  if (!result.ok || result.value.kind !== "api-surface")
    throw new Error("Expected surface");
  expect(result.value.groups).toEqual([]);
  expect(result.value.excluded_records).toEqual([
    { ordinal: 0, reason: "url-unparseable" },
    { ordinal: 1, reason: "url-unparseable" },
    { ordinal: 2, reason: "url-unparseable" },
  ]);
  expect(JSON.stringify(result.value)).not.toContain("pass");
});

it("keeps distinct content types without repeating a retained essence", () => {
  const capture = analysisViewCaptureFixture();
  const record = capture.records[0]!;
  const types = ["text/plain", "application/json", "text/plain"];
  capture.records = types.map((mimeType, ordinal) => ({
    ...record,
    ordinal,
    reported: {
      request: { method: "GET", url: "https://api.example.test/a" },
      response: { status: 200, content: { mimeType } },
    },
  }));
  capture.total_records = capture.records.length;
  const result = project(capture);
  if (!result.ok || result.value.kind !== "api-surface")
    throw new Error("Expected surface");
  expect(result.value.groups[0]?.content_types).toEqual([
    "application/json",
    "text/plain",
  ]);
});

it("charges repeated observed values once when merging", () => {
  const capture = analysisViewCaptureFixture();
  const record = capture.records[0]!;
  const path = "/1".repeat(800);
  capture.records = Array.from({ length: 1_000 }, (_, ordinal) => ({
    ...record,
    ordinal,
    reported: {
      request: { method: "GET", url: `https://api.example.test${path}` },
    },
  }));
  capture.total_records = capture.records.length;
  const result = project(capture);
  if (!result.ok || result.value.kind !== "api-surface")
    throw new Error("Expected surface");
  expect(result.value.groups).toHaveLength(1);
  expect(result.value.groups[0]?.templated_segments).toHaveLength(800);
});

it("keeps a recorded literal placeholder apart from a templated segment", () => {
  const capture = analysisViewCaptureFixture();
  capture.records = capture.records.slice(0, 2);
  const urls = [
    "https://api.example.test/users/{numeric}",
    "https://api.example.test/users/123",
  ];
  capture.records.forEach((record, index) => {
    record.reported = { request: { method: "GET", url: urls[index] ?? null } };
  });
  const result = project(capture);
  if (!result.ok || result.value.kind !== "api-surface")
    throw new Error("Expected surface");
  expect(result.value.groups).toHaveLength(2);
  expect(
    result.value.groups.map((group) => group.templated_segments.length).sort(),
  ).toEqual([0, 1]);
});

it("treats malformed media types as unknown and keeps source limitations", () => {
  const capture = analysisViewCaptureFixture();
  const caveat =
    "HAR text is producer-decoded Unicode. Original body bytes remain unknown.";
  const captureCaveat = "Producer omitted exchanges before capture startup.";
  capture.limitations = [captureCaveat, caveat];
  const malformed = [
    "text /plain",
    "unknown",
    "\u00a0text/plain\u00a0",
    "\u000btext/plain\u000b",
    "\u000ctext/plain\u000c",
    "text/K",
  ];
  capture.records = malformed.map((_, ordinal) => ({
    ...capture.records[0]!,
    ordinal,
  }));
  capture.total_records = capture.records.length;
  capture.records.forEach((record, index) => {
    record.limitations = [caveat];
    record.reported = {
      request: { method: "GET", url: "https://api.example.test/a" },
      response: {
        status: 200,
        content: { mimeType: malformed[index]! },
      },
    };
  });
  const result = project(capture);
  if (!result.ok || result.value.kind !== "api-surface")
    throw new Error("Expected surface");
  expect(result.value.groups[0]).toMatchObject({
    content_types: [],
    flags: [],
  });
  expect(result.value.unknowns).not.toEqual([]);
  expect(result.value.limitations).toContain(caveat);
  expect(result.value.limitations).toContain(captureCaveat);
  expect(result.value.limitations.filter((item) => item === caveat)).toEqual([
    caveat,
  ]);
});

it("compares media types case-insensitively and counts templated groups across pages", () => {
  const capture = analysisViewCaptureFixture();
  capture.records = capture.records.slice(0, 3);
  const reported = [
    ["https://api.example.test/a", "Application/JSON"],
    ["https://api.example.test/a", " \tapplication/json\t ; charset=utf-8"],
    ["https://api.example.test/users/7", "application/json"],
  ];
  capture.records.forEach((record, index) => {
    const [url, mimeType] = reported[index] ?? [];
    record.reported = {
      request: { method: "GET", url: url ?? null },
      response: { status: 200, content: { mimeType: mimeType ?? null } },
    };
  });
  const result = project(capture, 0, 1);
  if (!result.ok || result.value.kind !== "api-surface")
    throw new Error("Expected surface");
  expect(result.value.groups[0]).toMatchObject({
    path_template: "/a",
    content_types: ["application/json"],
    flags: [],
  });
  expect(result.value.templated_groups).toBe(1);
});

const HEADER_NONCES = [
  "AbCdEfGhIjKlMnOpQrSt_1",
  "AbCdEfGhIjKlMnOpQrSt-2",
  "AbCdEfGhIjKlMnOpQrSt_3",
];

/** Decoded-HAR records: credential values are null with their redaction sidecars. */
const headerFacetCapture = () => {
  const capture = analysisViewCaptureFixture();
  const template = capture.records[0]!;
  const record = (
    ordinal: number,
    request: Record<string, unknown>,
    response: Record<string, unknown>,
  ) => {
    const headers = (request.headers ?? []) as { value: unknown }[];
    const responseHeaders = (response.headers ?? []) as { value: unknown }[];
    return {
      ...template,
      ordinal,
      location: {
        kind: "json-pointer" as const,
        pointer: `/log/entries/${ordinal}`,
      },
      reported: JSON.parse(JSON.stringify({ request, response })),
      redactions: [
        ...headers.flatMap((header, index) =>
          header.value === null
            ? [
                {
                  pointer: `/request/headers/${index}/value`,
                  reason: "transport-credential" as const,
                },
              ]
            : [],
        ),
        ...responseHeaders.flatMap((header, index) =>
          header.value === null
            ? [
                {
                  pointer: `/response/headers/${index}/value`,
                  reason: "transport-credential" as const,
                },
              ]
            : [],
        ),
      ],
    };
  };
  const signed = [7, 2, 11].map((ordinal, index) =>
    record(
      ordinal,
      {
        method: "POST",
        url: "https://api.test/v1/orders",
        headers: [
          { name: ":authority", value: "api.test" },
          { name: "Authorization", value: null },
          {
            name: "X-Signature",
            value: REQUEST_HEADER_FACET_VALUES[3 + index],
          },
          {
            name: "X-Timestamp",
            value: REQUEST_HEADER_FACET_VALUES[6 + index],
          },
          { name: "Accept", value: "application/vnd.fixture-accept+json" },
          ...(index === 0 ? [{ name: "ACCEPT", value: "text/plain" }] : []),
          { name: "Sec-Fetch-Mode", value: "navigate-fixture" },
          { name: "Cookie", value: null },
          { name: "X-Nonce", value: HEADER_NONCES[index] },
        ],
        cookies: [
          [{ name: "session", value: null }],
          [
            { name: "session", value: null },
            { name: "theme", value: null },
          ],
          [],
        ][index],
      },
      {
        status: 201,
        content: { mimeType: "application/json" },
        headers: index === 1 ? [] : [{ name: "Set-Cookie", value: null }],
        cookies: index === 0 ? [{ name: "csrf", value: null }] : [],
      },
    ),
  );
  capture.total_records = 20;
  capture.records = [
    ...signed,
    record(
      4,
      {
        method: "GET",
        url: "https://api.test/health",
        headers: [{ name: "X-Single-Sample", value: "only-once-value" }],
        cookies: [],
      },
      {
        status: 200,
        content: { mimeType: "text/plain" },
        headers: [],
        cookies: [],
      },
    ),
  ];
  return capture;
};

const projectSurface = (
  capture: ReturnType<typeof analysisViewCaptureFixture>,
  selection: Record<string, unknown> = {},
  parameters: unknown = { sensitive_value_count: 0 },
) => {
  const parent = analysisViewCaptureEvidence(capture);
  return projectAnalysisView(
    {
      evidenceId: parent.evidence_id,
      operation: parent.operation,
      normalizedResult: parent.normalized_result,
      limitations: [],
      parameters,
    },
    { kind: "api-surface", offset: 0, limit: 50, ...selection },
  );
};

const surfaceOf = (result: ReturnType<typeof projectSurface>) => {
  if (!result.ok) throw result.error;
  if (result.value.kind !== "api-surface") throw new Error("Expected surface");
  return result.value;
};

it("keeps default API-surface bytes unchanged for header-rich records", () => {
  const omitted = surfaceOf(projectSurface(headerFacetCapture()));
  // Digest of this projection computed by unmodified main code (fffb07419,
  // which includes null relationship_coverage in Evidence IDs); header facets
  // must not alter it.
  expect(
    createHash("sha256").update(JSON.stringify(omitted)).digest("hex"),
  ).toBe("b305989dd76bd6a606f7e26c070a4ff3cce5ac513d4ebb11432adcc3f655e6bb");
});

it("reports value-free header, cookie and set-cookie facets with labelled inferences", () => {
  const capture = headerFacetCapture();
  const omitted = surfaceOf(projectSurface(capture));
  const selected = surfaceOf(
    projectSurface(capture, {
      request_header_facets: { scope: "script-settable" },
    }),
  );
  expect(
    selected.groups.map(
      ({ request_header_facets: _facets, ...group }) => group,
    ),
  ).toEqual(omitted.groups);
  const token = [{ kind: "per-request-token-candidate", basis: "inferred" }];
  expect(selected.groups.map((group) => group.request_header_facets)).toEqual([
    {
      scope: "script-settable",
      excluded_names: 0,
      request_headers: [
        {
          name: "x-single-sample",
          present_records: 1,
          redacted_records: 0,
          distinct_values: 1,
          value_length: { min: 15, max: 15 },
          alphabets: ["base64url"],
          variation: "single-sample",
          inferences: [],
        },
      ],
      unavailable_header_name_ordinals: [],
      cookie_names: [],
      unavailable_cookie_name_ordinals: [],
      set_cookie_names: [],
      unavailable_set_cookie_name_ordinals: [],
    },
    {
      scope: "script-settable",
      excluded_names: 3,
      request_headers: [
        {
          name: "accept",
          present_records: 3,
          redacted_records: 0,
          distinct_values: 2,
          value_length: { min: 10, max: 35 },
          alphabets: ["base64", "other"],
          variation: "varying",
          inferences: [],
        },
        {
          name: "authorization",
          present_records: 3,
          redacted_records: 3,
          distinct_values: null,
          value_length: null,
          alphabets: [],
          variation: "unknown",
          inferences: [],
        },
        {
          name: "x-nonce",
          present_records: 3,
          redacted_records: 0,
          distinct_values: 3,
          value_length: { min: 22, max: 22 },
          alphabets: ["base64url"],
          variation: "per-record-unique",
          inferences: token,
        },
        {
          name: "x-signature",
          present_records: 3,
          redacted_records: 0,
          distinct_values: 3,
          value_length: { min: 64, max: 64 },
          alphabets: ["hex"],
          variation: "per-record-unique",
          inferences: token,
        },
        {
          name: "x-timestamp",
          present_records: 3,
          redacted_records: 0,
          distinct_values: 3,
          value_length: { min: 13, max: 13 },
          alphabets: ["decimal"],
          variation: "per-record-unique",
          inferences: [
            { kind: "epoch-timestamp-candidate", basis: "inferred" },
          ],
        },
      ],
      unavailable_header_name_ordinals: [],
      cookie_names: [
        { name: "session", record_ordinals: [7, 2] },
        { name: "theme", record_ordinals: [2] },
      ],
      unavailable_cookie_name_ordinals: [11],
      set_cookie_names: [{ name: "csrf", record_ordinals: [7] }],
      unavailable_set_cookie_name_ordinals: [11],
    },
  ]);
  expect(selected.limitations.length).toBe(omitted.limitations.length + 1);
  expect(selected.header_inference_groups).toBe(1);
  expect(Object.hasOwn(omitted, "header_inference_groups")).toBe(false);
  const all = surfaceOf(
    projectSurface(capture, {
      request_header_facets: { scope: "all" },
    }),
  );
  const orders = all.groups[1]?.request_header_facets;
  expect(orders).toMatchObject({ scope: "all", excluded_names: 0 });
  expect(orders?.request_headers.map((header) => header.name)).toEqual([
    ":authority",
    "accept",
    "authorization",
    "cookie",
    "sec-fetch-mode",
    "x-nonce",
    "x-signature",
    "x-timestamp",
  ]);
  expect(orders?.request_headers[3]).toMatchObject({
    name: "cookie",
    redacted_records: 3,
    distinct_values: null,
    variation: "unknown",
  });
  expect(orders?.request_headers[4]).toMatchObject({
    alphabets: ["base64url"],
    variation: "constant",
    inferences: [],
  });
  for (const view of [selected, all])
    for (const value of [...REQUEST_HEADER_FACET_VALUES, ...HEADER_NONCES])
      expect(JSON.stringify(view)).not.toContain(value);
});

it("applies fixed inference thresholds without reading header names", () => {
  const capture = analysisViewCaptureFixture();
  const columns: Record<string, readonly (string | undefined)[]> = {
    // Two samples are too few for a per-request token.
    "x-a": ["0123456789abcdef0", "0123456789abcdef1", undefined],
    // Two varying epoch-shaped samples are too few for a timestamp candidate.
    "x-h": ["1760000000", "1760000001", undefined],
    // Fifteen characters are too short.
    "x-b": ["0123456789abcde", "0123456789abcdf", "0123456789abce0"],
    // Every value is decimal: an epoch candidate, not a token.
    "x-c": ["1760000000", "1760000001", "1760000000"],
    // Constant decimals do not vary.
    "x-d": ["1760000000000", "1760000000000", "1760000000000"],
    // Mixed epoch widths are not one timestamp shape.
    "x-e": ["1760000000", "1760000000000", "1760000000001"],
    // Padded base64 with a repeat varies but is not unique.
    "x-f": [
      "ab+/cdefghijklmnop==",
      "ab+/cdefghijklmnop==",
      "ab+/cdefghijklmnoq==",
    ],
    // One value outside the token alphabets prevents the token rule.
    "x-g": ["0123456789abcdef0", "0123456789abcdef1", "0123456789abcdef.2"],
    // Names do not select rules; Unicode and empty values are other.
    authorization: ["雪0123456789abcdef", "", "0123456789abcdef9"],
  };
  capture.records = capture.records.slice(0, 3).map((record, index) => ({
    ...record,
    reported: {
      request: {
        method: "GET",
        url: "https://api.test/plain",
        headers: Object.entries(columns).flatMap(([name, values]) =>
          values[index] === undefined ? [] : [{ name, value: values[index] }],
        ),
        cookies: [],
      },
      response: { status: 200, headers: [], cookies: [] },
    },
  }));
  const surface = surfaceOf(
    projectSurface(capture, {
      request_header_facets: { scope: "script-settable" },
    }),
  );
  const rows = surface.groups[0]?.request_header_facets?.request_headers ?? [];
  expect(
    Object.fromEntries(
      rows.map((row) => [
        row.name,
        [row.variation, row.alphabets, row.inferences.map((item) => item.kind)],
      ]),
    ),
  ).toEqual({
    authorization: ["per-record-unique", ["hex", "other"], []],
    "x-a": ["per-record-unique", ["hex"], []],
    "x-b": ["per-record-unique", ["hex"], []],
    "x-c": ["varying", ["decimal"], ["epoch-timestamp-candidate"]],
    "x-d": ["constant", ["decimal"], []],
    "x-e": ["per-record-unique", ["decimal"], []],
    "x-f": ["varying", ["base64"], []],
    "x-g": ["per-record-unique", ["hex", "other"], []],
    "x-h": ["per-record-unique", ["decimal"], []],
  });
  expect(surface.templated_groups).toBe(0);
  expect(surface.header_inference_groups).toBe(1);
});

it("keeps unreadable header and cookie names unknown instead of absent", () => {
  const capture = analysisViewCaptureFixture();
  const reported = [
    {
      request: {
        method: "GET",
        url: "https://api.test/partial",
        headers: [
          { name: "X-Producer-Null", value: null },
          { name: 7, value: "unnamed" },
        ],
        cookies: [{ value: "nameless" }, { name: "kept" }],
      },
      response: { status: 200, headers: "unavailable", cookies: [] },
    },
    {
      request: {
        method: "GET",
        url: "https://api.test/partial",
        headers: [{ name: "x-producer-null", value: "zzvalue" }],
        cookies: "unavailable",
      },
    },
  ];
  capture.records = capture.records.slice(0, 2).map((record, index) => ({
    ...record,
    reported: reported[index]!,
  }));
  const facets = surfaceOf(
    projectSurface(capture, {
      request_header_facets: { scope: "script-settable" },
    }),
  ).groups[0]?.request_header_facets;
  expect(facets).toEqual({
    scope: "script-settable",
    excluded_names: 0,
    request_headers: [
      {
        name: "x-producer-null",
        present_records: 2,
        redacted_records: 0,
        distinct_values: null,
        value_length: { min: 7, max: 7 },
        alphabets: ["base64url"],
        variation: "unknown",
        inferences: [],
      },
    ],
    unavailable_header_name_ordinals: [0],
    cookie_names: [{ name: "kept", record_ordinals: [0] }],
    unavailable_cookie_name_ordinals: [0, 1],
    set_cookie_names: [],
    unavailable_set_cookie_name_ordinals: [0, 1],
  });
  for (const value of ["unnamed", "nameless", "zzvalue"])
    expect(JSON.stringify(facets)).not.toContain(value);
});

it("preserves sensitive-parent refusal when header facets are selected", () => {
  expect(
    projectSurface(
      headerFacetCapture(),
      { request_header_facets: { scope: "all" } },
      { sensitive_value_count: 1 },
    ),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisUnsupportedTargetError",
      reason: "sensitive_values_unretained",
    },
  });
});
