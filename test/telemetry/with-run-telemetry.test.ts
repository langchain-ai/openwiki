import { beforeEach, describe, expect, test, vi } from "vitest";

import type { OpenWikiRunOptions } from "../../src/agent/types.ts";
import type { RunTelemetryContext } from "../../src/telemetry/with-run-telemetry.ts";

// recordRunSafe is the single recording side effect; mock it so nothing is sent
// and its arguments can be asserted. describeErrorForTelemetry is left REAL, so the
// failure path proves the error is reduced to anonymous, closed-set diagnostics
// before it reaches the recorder.
const recordRunSafe = vi.fn(() => Promise.resolve(undefined));

vi.mock("../../src/telemetry/record-run-safe.ts", () => ({
  recordRunSafe: (...args: unknown[]) => recordRunSafe(...args),
}));

import { withRunTelemetry } from "../../src/telemetry/with-run-telemetry.ts";

const OPTIONS = { outputMode: "repository" } as OpenWikiRunOptions;

/** The captured (command, options, facts) of the single recordRunSafe call. */
function recordedFacts(): Record<string, unknown> {
  return recordRunSafe.mock.calls[0]?.[2] as Record<string, unknown>;
}

beforeEach(() => {
  recordRunSafe.mockClear();
});

describe("withRunTelemetry", () => {
  test("returns the run's result and records a clean run as success", async () => {
    const ctx: RunTelemetryContext = { provider: "anthropic" };

    const result = await withRunTelemetry("init", OPTIONS, ctx, () =>
      Promise.resolve("done"),
    );

    expect(result).toBe("done");
    expect(recordRunSafe).toHaveBeenCalledTimes(1);
    expect(recordRunSafe.mock.calls[0]?.[0]).toBe("init");
    expect(recordRunSafe.mock.calls[0]?.[1]).toBe(OPTIONS);
    expect(recordedFacts()).toEqual({
      provider: "anthropic",
      outcome: "success",
    });
  });

  test("records the noop outcome the agent published on ctx", async () => {
    const ctx: RunTelemetryContext = { provider: "openai", outcome: "noop" };

    await withRunTelemetry("update", OPTIONS, ctx, () => Promise.resolve(1));

    expect(recordedFacts()).toEqual({ provider: "openai", outcome: "noop" });
  });

  test("attributes provider 'undefined' when ctx never resolved one", async () => {
    const ctx: RunTelemetryContext = {};

    await withRunTelemetry("init", OPTIONS, ctx, () => Promise.resolve(1));

    // recordRunSafe maps an absent provider to "unknown" itself; the wrapper just
    // forwards whatever ctx holds, which here is undefined.
    expect(recordedFacts()).toEqual({
      provider: undefined,
      outcome: "success",
    });
  });

  test("records failure with anonymized diagnostics and rethrows", async () => {
    const ctx: RunTelemetryContext = { provider: "anthropic" };
    const boom = new TypeError("secret-bearing message");

    await expect(
      withRunTelemetry("init", OPTIONS, ctx, () => Promise.reject(boom)),
    ).rejects.toBe(boom);

    expect(recordRunSafe).toHaveBeenCalledTimes(1);
    const facts = recordedFacts();
    expect(facts).toMatchObject({
      provider: "anthropic",
      outcome: "failure",
      // The real describeErrorForTelemetry ran: a residual throw is agent_error
      // fingerprinted by the error's name, never its message.
      errorClass: "agent_error",
      errorDetail: "TypeError",
    });
    // The raw message must never enter the recorded payload.
    expect(JSON.stringify(facts)).not.toContain("secret-bearing message");
  });
});
