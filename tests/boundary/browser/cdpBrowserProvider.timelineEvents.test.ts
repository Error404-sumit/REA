import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

describe("CdpBrowserProvider navigation timeline", () => {
  it.each(["outside_policy", "target_detached"] as const)(
    "settles and releases a long wait after %s",
    async (sessionTimeline) => {
      const browser = await startFakeCdpBrowser({ sessionTimeline });
      trackBrowser(browser);
      const result = await new CdpBrowserProvider().observeSession(
        observeWebSessionInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
          observation_ms: 3_000_000_000,
        }),
      );
      if (!result.ok) throw result.error;
      expect(result.value.window.end_reason).toBe(
        sessionTimeline === "outside_policy"
          ? "target_left_scope"
          : "target_terminated",
      );
    },
  );
  it.each([2_147_483_648, 3_000_000_000])(
    "keeps a long observation pending until cancellation: %s",
    async (observation_ms) => {
      const browser = await startFakeCdpBrowser();
      trackBrowser(browser);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let armed = false;
      try {
        const result = await new CdpBrowserProvider().observeSession(
          observeWebSessionInputSchema.parse({
            cdp_endpoint: browser.endpoint,
            allowed_origins: [browser.allowedOrigin],
            target_id: "allowed-page",
            observation_ms,
          }),
          {
            signal: controller.signal,
            progress: {
              report: async (update) => {
                if (
                  update.phase === "browser_observation" &&
                  update.completed === 1
                ) {
                  armed = true;
                  timer = setTimeout(() => controller.abort(), 150);
                }
              },
            },
          },
        );
        expect(result).toMatchObject({
          ok: false,
          error: { _tag: "AnalysisCancelledError" },
        });
        expect(armed).toBe(true);
      } finally {
        clearTimeout(timer);
      }
    },
  );
  it("returns every event beyond the former default collection cap", async () => {
    const additionalEvents = 2_001;
    const browser = await startFakeCdpBrowser({
      pageScopedVersionWebSocket: true,
      omitTargetWebSocket: true,
      sessionTimeline: "same_origin",
      sessionTimelineEventCount: additionalEvents,
    });
    trackBrowser(browser);

    const result = await new CdpBrowserProvider().observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 1,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.timeline).toHaveLength(additionalEvents + 6);
    expect(result.value.completeness.truncated_sections).not.toContain(
      "timeline",
    );
  });
});
