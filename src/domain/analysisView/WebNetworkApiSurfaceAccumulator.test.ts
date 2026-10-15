import { Hash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { analysisViewCaptureFixture } from "../../../tests/fixtures/analysisView.js";
import type { WebNetworkCaptureRecord } from "../webNetworkCapture.js";
import { WebNetworkApiSurfaceAccumulator } from "./WebNetworkApiSurfaceAccumulator.js";
import { recordHeaderScratchBytes } from "./webNetworkRequestHeaderFacets.js";

const record = (
  ordinal: number,
  path: string,
  method = "GET",
  mimeType = "application/json",
): WebNetworkCaptureRecord => ({
  ...analysisViewCaptureFixture().records[0]!,
  ordinal,
  limitations: [],
  reported: {
    request: { method, url: `https://api.test${path}` },
    response: { status: 200, content: { mimeType } },
  },
});

const add = (
  accumulator: WebNetworkApiSurfaceAccumulator,
  sample: WebNetworkCaptureRecord,
) => {
  const result = accumulator.add(sample);
  if (!result.ok) throw result.error;
};

it("bounds query parser expansion before publishing or merging observed names", () => {
  const accumulator = new WebNetworkApiSurfaceAccumulator({
    maximumBytes: 64 * 1024,
    includeQueryParameterNames: true,
  });
  add(accumulator, record(0, "/products?kept=1"));
  const before = accumulator.page(0, 1);
  expect(
    accumulator.add(record(1, `/products?${"x=1&".repeat(200)}`)),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError" },
  });
  expect(accumulator.page(0, 1)).toEqual(before);
  add(accumulator, record(2, "/products?after=2"));
  expect(accumulator.page(0, 1).groups[0]?.query_parameter_names).toEqual([
    { name: "after", record_ordinals: [2] },
    { name: "kept", record_ordinals: [0] },
  ]);
});

it("charges each retained name once and each name's ordinal once per request", () => {
  const accumulator = new WebNetworkApiSurfaceAccumulator({
    maximumBytes: 1024 * 1024,
    includeQueryParameterNames: true,
  });
  for (let ordinal = 0; ordinal < 1000; ordinal += 1)
    add(accumulator, record(ordinal, "/products?category=one&category=two"));
  expect(accumulator.page(0, 1).groups[0]?.query_parameter_names).toEqual([
    {
      name: "category",
      record_ordinals: Array.from({ length: 1000 }, (_, index) => index),
    },
  ]);
});

it("admits the capture schema clone and grouping against the same budget", () => {
  const sample = record(0, `/${"a".repeat(1200)}`);
  const isolated = new WebNetworkApiSurfaceAccumulator({
    maximumBytes: 64 * 1024,
  });
  add(isolated, sample);
  const accumulator = new WebNetworkApiSurfaceAccumulator({
    maximumBytes: 64 * 1024,
  });
  expect(
    accumulator.admitCaptureClone({
      headers: Array.from({ length: 40 }, () => ({ name: "x", value: "y" })),
    }).ok,
  ).toBe(true);
  expect(accumulator.add(sample)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError" },
  });
  expect(accumulator.page(0, 1).groups).toEqual([]);
});

it.each(["admitCaptureClone", "admitInlineEvidence"] as const)(
  "%s refuses dense array expansion without enumerating its keys",
  (method) => {
    const array = Array.from({ length: 100_000 }, () => null);
    let enumerated = false;
    let inspected = 0;
    const ownNames = Object.getOwnPropertyNames;
    const ownDescriptor = Object.getOwnPropertyDescriptor;
    const keys = vi
      .spyOn(Object, "getOwnPropertyNames")
      .mockImplementation((value) => {
        if (value === array) enumerated = true;
        return ownNames(value);
      });
    const descriptors = vi
      .spyOn(Object, "getOwnPropertyDescriptor")
      .mockImplementation((value, key) => {
        if (value === array) inspected += 1;
        return ownDescriptor(value, key);
      });
    try {
      expect(
        new WebNetworkApiSurfaceAccumulator({ maximumBytes: 4096 })[method](
          array,
        ),
      ).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
      });
      expect(enumerated).toBe(false);
      expect(inspected).toBeGreaterThan(0);
      expect(inspected).toBeLessThan(16);
    } finally {
      keys.mockRestore();
      descriptors.mockRestore();
    }
  },
);

it("charges non-enumerable fields that the capture schema would clone", () => {
  const value = Object.defineProperty({}, "records", {
    value: Array.from({ length: 100 }, () => ({ reported: {} })),
  });
  expect(
    new WebNetworkApiSurfaceAccumulator({
      maximumBytes: 64 * 1024,
    }).admitCaptureClone(value),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError" },
  });
});

it("bounds many short literal groups, including groups with unavailable MIME types", () => {
  const accumulator = new WebNetworkApiSurfaceAccumulator({
    maximumBytes: 64 * 1024,
  });
  let accepted = 0;
  for (; accepted < 1000; accepted += 1) {
    const before = accumulator.page(0, 1000);
    const result = accumulator.add(
      record(accepted, `/route${accepted}`, "GET", ""),
    );
    if (result.ok) continue;
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
    });
    expect(accumulator.page(0, 1000)).toEqual(before);
    break;
  }
  expect(accepted).toBeGreaterThan(0);
  expect(accepted).toBeLessThan(1000);
  expect(accumulator.page(0, 1000).coverage.total).toBe(accepted);
});

it.each([
  {
    name: "templated segments",
    path: "/1".repeat(350),
    method: "GET",
    mime: "application/json",
  },
  {
    name: "literal path",
    path: `/${"a".repeat(30_000)}`,
    method: "GET",
    mime: "application/json",
  },
  {
    name: "request identity",
    path: "/a",
    method: "M".repeat(60_000),
    mime: "application/json",
  },
  {
    name: "response text",
    path: "/a",
    method: "GET",
    mime: `text/${"a".repeat(30_000)}`,
  },
])(
  "admits $name together with previously retained state before publishing a new group",
  ({ path, method, mime }) => {
    const maximum = 1024 * 1024;
    const isolated = new WebNetworkApiSurfaceAccumulator({
      maximumBytes: maximum,
    });
    add(isolated, record(0, path, method, mime));

    const accumulator = new WebNetworkApiSurfaceAccumulator({
      maximumBytes: maximum,
    });
    for (let ordinal = 0; ordinal < 150; ordinal += 1)
      add(accumulator, record(ordinal, `/route${ordinal}`));
    const before = accumulator.page(0, 1000);
    expect(accumulator.add(record(150, path, method, mime))).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisResourceConstraintError" },
    });
    expect(accumulator.page(0, 1000)).toEqual(before);
  },
);

it("retains repeated segment, status and MIME values once across many samples", () => {
  const accumulator = new WebNetworkApiSurfaceAccumulator({
    maximumBytes: 1024 * 1024,
  });
  for (let ordinal = 0; ordinal < 1000; ordinal += 1)
    add(accumulator, record(ordinal, "/1".repeat(250)));
  const page = accumulator.page(0, 1);
  expect(page.groups).toHaveLength(1);
  expect(page.groups[0]?.record_ordinals).toHaveLength(1000);
  expect(page.groups[0]?.statuses).toEqual([200]);
  expect(page.groups[0]?.content_types).toEqual(["application/json"]);
  expect(page.groups[0]?.templated_segments).toHaveLength(250);
  expect(
    page.groups[0]?.templated_segments.every(
      (segment) => segment.observed_values.join() === "1",
    ),
  ).toBe(true);
});

it("refuses an entire merge before retaining any novel observed values or its ordinal", () => {
  const accumulator = new WebNetworkApiSurfaceAccumulator({
    maximumBytes: 1024 * 1024,
  });
  for (let ordinal = 0; ordinal < 100; ordinal += 1)
    add(accumulator, record(ordinal, `/route${ordinal}`));
  add(accumulator, record(100, "/1".repeat(200)));
  const before = accumulator.page(0, 1000);
  const result = accumulator.add(
    record(101, `/${"2".repeat(80)}`.repeat(200), "GET", "text/plain"),
  );
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError" },
  });
  expect(accumulator.page(0, 1000)).toEqual(before);
});

it("bounds excluded-record storage and distinct limitations as well as endpoint groups", () => {
  const accumulator = new WebNetworkApiSurfaceAccumulator({
    maximumBytes: 64 * 1024,
  });
  let accepted = 0;
  for (; accepted < 1000; accepted += 1) {
    const sample = record(accepted, "/a");
    sample.reported = null;
    sample.limitations = [`producer caveat ${accepted}`];
    const result = accumulator.add(sample);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
      });
      break;
    }
  }
  expect(accepted).toBeGreaterThan(0);
  expect(accepted).toBeLessThan(1000);
  expect(accumulator.page(0, 1).excluded_records).toHaveLength(accepted);
});

const headerRecord = (
  ordinal: number,
  headers: readonly { name: string; value: string | null }[],
  cookies: readonly string[] = [],
): WebNetworkCaptureRecord => ({
  ...record(ordinal, "/signed"),
  reported: {
    request: {
      method: "GET",
      url: "https://api.test/signed",
      headers: [...headers],
      cookies: cookies.map((name) => ({ name, value: null })),
    },
    response: {
      status: 200,
      content: { mimeType: "application/json" },
      headers: [],
      cookies: [],
    },
  },
});

it("refuses header facet scratch before reading a record's header lines", () => {
  const accumulator = new WebNetworkApiSurfaceAccumulator({
    maximumBytes: 64 * 1024,
    requestHeaderScope: "all",
  });
  add(accumulator, headerRecord(0, [{ name: "x-kept", value: "a" }], ["kept"]));
  const before = accumulator.page(0, 1);
  const lines = Array.from({ length: 200 }, (_, index) => ({
    name: `x-${index}`,
    value: `${index}`,
  }));
  expect(accumulator.add(headerRecord(1, lines))).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError" },
  });
  expect(accumulator.page(0, 1)).toEqual(before);
  add(
    accumulator,
    headerRecord(2, [{ name: "X-Kept", value: "b" }], ["after"]),
  );
  expect(accumulator.page(0, 1).groups[0]?.request_header_facets).toMatchObject(
    {
      request_headers: [
        { name: "x-kept", present_records: 2, distinct_values: 2 },
      ],
      cookie_names: [
        { name: "after", record_ordinals: [2] },
        { name: "kept", record_ordinals: [0] },
      ],
    },
  );
});

it("admits each distinct value digest before growing a header row", () => {
  const accumulator = new WebNetworkApiSurfaceAccumulator({
    maximumBytes: 64 * 1024,
    requestHeaderScope: "all",
  });
  let accepted = 0;
  for (; accepted < 1000; accepted += 1) {
    const before = accumulator.page(0, 1);
    const added = accumulator.add(
      headerRecord(accepted, [{ name: "x-nonce", value: `nonce-${accepted}` }]),
    );
    if (added.ok) continue;
    expect(added.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
    });
    expect(accumulator.page(0, 1)).toEqual(before);
    break;
  }
  expect(accepted).toBeGreaterThan(0);
  expect(accepted).toBeLessThan(1000);
  expect(
    accumulator.page(0, 1).groups[0]?.request_header_facets?.request_headers,
  ).toMatchObject([
    {
      name: "x-nonce",
      present_records: accepted,
      distinct_values: accepted,
      variation: "per-record-unique",
    },
  ]);
});

it("charges repeated header names, values and cookie names once", () => {
  const accumulator = new WebNetworkApiSurfaceAccumulator({
    maximumBytes: 1024 * 1024,
    requestHeaderScope: "script-settable",
  });
  for (let ordinal = 0; ordinal < 1000; ordinal += 1)
    add(
      accumulator,
      headerRecord(
        ordinal,
        [
          { name: "Accept", value: "application/json" },
          { name: "Cookie", value: null },
          { name: "Sec-Fetch-Mode", value: "cors" },
          { name: "accept", value: "text/plain" },
        ],
        ["session", "session"],
      ),
    );
  expect(accumulator.page(0, 1).groups[0]?.request_header_facets).toEqual({
    scope: "script-settable",
    excluded_names: 2,
    request_headers: [
      {
        name: "accept",
        present_records: 1000,
        redacted_records: 0,
        distinct_values: 1,
        value_length: { min: 10, max: 16 },
        alphabets: ["base64"],
        variation: "constant",
        inferences: [],
      },
    ],
    unavailable_header_name_ordinals: [],
    cookie_names: [
      {
        name: "session",
        record_ordinals: Array.from({ length: 1000 }, (_, index) => index),
      },
    ],
    unavailable_cookie_name_ordinals: [],
    set_cookie_names: [],
    unavailable_set_cookie_name_ordinals: [],
  });
});

it("charges long header values for bounded hash slices rather than their length", () => {
  const long = "a".repeat(4 * 1024 * 1024);
  const cost = {
    entry: 128,
    container: 512,
    scratch: 512,
    digest: 192,
    text: (length: number) => 32 + length * 14,
  };
  // Borrowed values are hashed in fixed slices, so scratch does not grow.
  expect(
    recordHeaderScratchBytes(
      headerRecord(0, [{ name: "x-long", value: long }]),
      cost,
    ),
  ).toBe(
    recordHeaderScratchBytes(
      headerRecord(0, [{ name: "x-long", value: "a" }]),
      cost,
    ),
  );
  // A whole-value UTF-16 encoding would need 8 MiB, 32 times this budget.
  const accumulator = new WebNetworkApiSurfaceAccumulator({
    maximumBytes: 256 * 1024,
    requestHeaderScope: "all",
  });
  const update = vi.spyOn(Hash.prototype, "update");
  try {
    for (const [ordinal, value] of [long, long, `${long.slice(1)}b`].entries())
      add(accumulator, headerRecord(ordinal, [{ name: "x-long", value }]));
    // No update materializes an encoding proportional to the whole value.
    const longest = update.mock.calls.reduce(
      (most, [data]) =>
        Math.max(most, typeof data === "string" ? data.length : 0),
      0,
    );
    expect(longest).toBeGreaterThan(0);
    expect(longest).toBeLessThanOrEqual(1024);
  } finally {
    update.mockRestore();
  }
  expect(
    accumulator.page(0, 1).groups[0]?.request_header_facets?.request_headers,
  ).toMatchObject([
    {
      name: "x-long",
      present_records: 3,
      distinct_values: 2,
      value_length: { min: long.length, max: long.length },
      variation: "varying",
    },
  ]);
});
