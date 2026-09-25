import { describe, expect, test, vi } from "vitest";

// Blank the publishable PostHog key so the "no key configured" guard is
// exercised; the real key is a hardcoded constant, so this is the only way to
// reach the early bail-out that must never construct a client or send anything.
vi.mock("../../src/telemetry/config.ts", () => ({
  DEFAULT_POSTHOG_KEY: "",
  DEFAULT_POSTHOG_HOST: "https://us.i.posthog.com",
  FLUSH_TIMEOUT_MS: 3000,
}));

const posthog = vi.hoisted(() => ({
  PostHog: vi.fn(),
}));
vi.mock("posthog-node", () => ({ PostHog: posthog.PostHog }));

import { capture } from "../../src/telemetry/client.ts";

describe("client.capture without a configured key", () => {
  test("reports not-sent and never constructs a client", async () => {
    const sent = await capture({
      distinctId: "id-1",
      event: "openwiki_run",
      properties: { command: "init" },
    });

    expect(sent).toBe(false);
    expect(posthog.PostHog).not.toHaveBeenCalled();
  });
});
