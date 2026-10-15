/** Synthetic HAR 1.2 fixture with producer-declared sizes independent of Unicode content. */
export const historicalHar = () => ({
  log: {
    version: "1.2",
    creator: { name: "rea-source-owned-fixture", version: "1" },
    entries: [
      {
        startedDateTime: "2026-10-07T13:00:00.123+08:00",
        time: 1.25,
        request: {
          method: "GET",
          url: "https://example.test/a?token=ordinary#fragment",
          httpVersion: "HTTP/2",
          cookies: [],
          headers: [],
          queryString: [],
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: "OK",
          httpVersion: "HTTP/2",
          cookies: [],
          headers: [],
          content: { size: 99, mimeType: "text/plain", text: "雪😀\r\n" },
          redirectURL: "",
          headersSize: -1,
          bodySize: 99,
        },
        cache: {},
        timings: { send: 0, wait: 1.25, receive: 0 },
      },
    ],
  },
});

/** Request paths exercising only the public API surface format rules. */
export const apiSurfaceHar = () => {
  const fixture = historicalHar();
  const entry = fixture.log.entries[0]!;
  const paths = [
    "/users/8812",
    "/users/9031",
    "/ids/550e8400-e29b-41d4-a716-446655440000",
    "/ids/abcdef0123456789abcdef0123456789",
    "/dates/2024-02-29",
    "/api/v1/users",
    "/api/v2/users",
    "/api/Report2",
    "/api/Report3",
    "/api/CreateDocument",
    "/api/ListDocuments",
    "/ids/abc123",
    "/dates/2023-02-29",
  ];
  fixture.log.entries = paths.map((path, index) => ({
    ...entry,
    request: {
      ...entry.request,
      url: `https://api.example.test${path}?not-in-view=value`,
    },
    response: {
      ...entry.response,
      status: index === 1 ? 404 : 200,
      content: {
        ...entry.response.content,
        mimeType:
          index === 1 ? "text/plain" : "application/json; charset=utf-8",
      },
    },
  }));
  return fixture;
};

/** Known header and cookie values that value-free API-surface facets must never copy. */
export const REQUEST_HEADER_FACET_VALUES = [
  "secret-token-",
  "secret-session-",
  "secret-csrf",
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752",
  "fd61a03af4f77d870fc21e05e7e80678095c92d808cfb3b5c279ee04c74aca13",
  "1760000000000",
  "1760000001000",
  "1760000002000",
  "vnd.fixture-accept",
  "navigate-fixture",
  "only-once-value",
] as const;

/** Signed-request HAR with credential headers, cookies and per-request values. */
export const requestHeaderFacetHar = () => {
  const { log } = historicalHar();
  const entry = log.entries[0]!;
  const signed = [0, 1, 2].map((index) => ({
    ...entry,
    request: {
      ...entry.request,
      method: "POST",
      url: "https://api.example.test/v1/orders",
      headers: [
        { name: ":authority", value: "api.example.test" },
        { name: "Authorization", value: `Bearer secret-token-${index}` },
        { name: "X-Signature", value: REQUEST_HEADER_FACET_VALUES[3 + index]! },
        { name: "X-Timestamp", value: REQUEST_HEADER_FACET_VALUES[6 + index]! },
        { name: "Accept", value: "application/vnd.fixture-accept+json" },
        { name: "Sec-Fetch-Mode", value: "navigate-fixture" },
        { name: "Cookie", value: `session=secret-session-${index}` },
      ],
      // The third producer kept the Cookie header but omitted parsed cookies.
      cookies:
        index === 2
          ? []
          : [{ name: "session", value: `secret-session-${index}` }],
    },
    response: {
      ...entry.response,
      headers:
        index === 0
          ? [{ name: "Set-Cookie", value: "csrf=secret-csrf; Path=/" }]
          : [],
      cookies: index === 0 ? [{ name: "csrf", value: "secret-csrf" }] : [],
    },
  }));
  const single = {
    ...entry,
    request: {
      ...entry.request,
      url: "https://api.example.test/health",
      headers: [{ name: "X-Single-Sample", value: "only-once-value" }],
    },
  };
  return { log: { ...log, entries: [...signed, single] } };
};
