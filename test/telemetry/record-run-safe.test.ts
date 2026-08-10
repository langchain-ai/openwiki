import { beforeEach, describe, expect, test, vi } from "vitest";

import type { OpenWikiRunOptions } from "../../src/agent/types.ts";

// recordRun is the sole downstream side effect; mock it so no telemetry is ever
// sent and the exact payload can be asserted. getConfiguredConnectorIds is mocked
// to a fixed set so the init-only setup fields are deterministic.
const recordRun = vi.fn(() => Promise.resolve(undefined));
const getConfiguredConnectorIds = vi.fn(() => ["github"]);

vi.mock("../../src/telemetry/senders.ts", () => ({
  recordRun: (...args: unknown[]) => recordRun(...args),
}));
vi.mock("../../src/connectors/registry.ts", () => ({
  getConfiguredConnectorIds: () => getConfiguredConnectorIds(),
}));

import { recordRunSafe } from "../../src/telemetry/record-run-safe.ts";

/** Builds run options with only the fields recordRunSafe reads. */
function options(
  overrides: Partial<OpenWikiRunOptions> = {},
): OpenWikiRunOptions {
  return overrides;
}

/** The single captured recordRun payload, typed for field assertions. */
function lastPayload(): Record<string, unknown> {
  return recordRun.mock.calls[0]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  recordRun.mockClear();
  getConfiguredConnectorIds.mockClear();
});

describe("recordRunSafe", () => {
  test("drops the interactive chat command without sending an event", async () => {
    await recordRunSafe("chat", options(), { outcome: "success" });

    expect(recordRun).not.toHaveBeenCalled();
  });

  test("records init with the setup fields captured at configuration time", async () => {
    await recordRunSafe(
      "init",
      options({ outputMode: "repository", telemetryFile: "/tmp/tel.json" }),
      { outcome: "success", provider: "anthropic" },
    );

    expect(recordRun).toHaveBeenCalledTimes(1);
    expect(lastPayload()).toMatchObject({
      command: "init",
      outcome: "success",
      // repository output mode maps to the "code" brain mode.
      mode: "code",
      provider: "anthropic",
      configuredConnectors: ["github"],
      telemetryFile: "/tmp/tel.json",
    });
  });

  test("maps a non-repository output mode to the personal brain mode", async () => {
    await recordRunSafe("init", options({ outputMode: "local-wiki" }), {
      outcome: "success",
      provider: "openai",
    });

    expect(lastPayload().mode).toBe("personal");
  });

  test("defaults a missing output mode to personal on init", async () => {
    await recordRunSafe("init", options(), {
      outcome: "success",
      provider: "openai",
    });

    // outputMode defaults to local-wiki, which is the personal brain mode.
    expect(lastPayload().mode).toBe("personal");
  });

  test("records provider 'unknown' when init resolved no provider", async () => {
    await recordRunSafe("init", options({ outputMode: "repository" }), {
      outcome: "failure",
    });

    expect(lastPayload().provider).toBe("unknown");
  });

  test("records update without any setup fields", async () => {
    await recordRunSafe(
      "update",
      options({ outputMode: "repository", telemetryFile: "/tmp/tel.json" }),
      { outcome: "success", provider: "anthropic" },
    );

    const payload = lastPayload();
    expect(payload).toMatchObject({
      command: "update",
      outcome: "success",
      telemetryFile: "/tmp/tel.json",
    });
    // Setup fields belong to init only; update omits them and never reads the
    // connector registry.
    expect(payload.mode).toBeUndefined();
    expect(payload.provider).toBeUndefined();
    expect(payload.configuredConnectors).toBeUndefined();
    expect(getConfiguredConnectorIds).not.toHaveBeenCalled();
  });

  test("forwards only closed-set failure diagnostics, never raw error text", async () => {
    await recordRunSafe("update", options(), {
      outcome: "failure",
      errorClass: "provider_error",
      errorDetail: "AnthropicError",
      errorOwner: "provider",
      errorStage: "agent",
      httpStatus: 529,
    });

    expect(lastPayload()).toMatchObject({
      outcome: "failure",
      errorClass: "provider_error",
      errorDetail: "AnthropicError",
      errorOwner: "provider",
      errorStage: "agent",
      httpStatus: 529,
    });
  });
});
