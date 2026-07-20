import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the two external boundaries so nothing hits the network and CI detection
// is deterministic. install-id and the tee use the real filesystem.
const ci = vi.hoisted(() => ({ isCI: false, name: null as string | null }));
vi.mock("ci-info", () => ({ default: ci }));

const posthog = vi.hoisted(() => {
  // `capture()` awaits captureImmediate's promise, so the mock returns one.
  const captureImmediate = vi.fn(() => Promise.resolve(undefined));
  const shutdown = vi.fn(() => Promise.resolve(undefined));
  // Regular function (not an arrow) so `new PostHog(...)` is constructable.
  const PostHog = vi.fn(function (this: Record<string, unknown>) {
    this.captureImmediate = captureImmediate;
    this.shutdown = shutdown;
  });
  return { captureImmediate, shutdown, PostHog };
});
vi.mock("posthog-node", () => ({ PostHog: posthog.PostHog }));

import { getConfiguredConnectorIds } from "../src/connectors/registry.ts";
import { capture as captureEvent } from "../src/telemetry/client.ts";
import { DEFAULT_POSTHOG_KEY } from "../src/telemetry/config.ts";
import { classifyError } from "../src/telemetry/errors.ts";
import {
  ciSentinelId,
  isCiEnvironment,
  isTelemetryDisabled,
  noticeSuppressed,
} from "../src/telemetry/gates.ts";
import { recordRun } from "../src/telemetry/senders.ts";
import type { RunTelemetry } from "../src/telemetry/types.ts";

const ENV_KEYS = [
  "OPENWIKI_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
  "OPENWIKI_SCHEDULED",
  "OPENWIKI_NOTION_MCP_ACCESS_TOKEN",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  ci.isCI = false;
  ci.name = null;
  posthog.captureImmediate.mockReset();
  posthog.captureImmediate.mockResolvedValue(undefined);
  posthog.shutdown.mockReset();
  posthog.shutdown.mockResolvedValue(undefined);
  posthog.PostHog.mockClear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

function runDetails(overrides: Partial<RunTelemetry> = {}): RunTelemetry {
  return {
    command: "init",
    outcome: "success",
    mode: "personal",
    provider: "anthropic",
    configuredConnectors: [],
    ...overrides,
  };
}

async function readTee(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

describe("classifyError", () => {
  test("maps known shapes to the right enum", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";

    expect(classifyError(abort)).toBe("aborted");
    expect(classifyError({ status: 401 })).toBe("provider_auth");
    expect(classifyError({ status: 403 })).toBe("provider_auth");
    expect(classifyError({ statusCode: 429 })).toBe("provider_rate_limit");
    expect(
      classifyError(new Error("OPENAI_API_KEY is required to run OpenWiki.")),
    ).toBe("missing_credentials");
    expect(
      classifyError(new Error("A base URL is required to run OpenWiki.")),
    ).toBe("missing_config");
    expect(classifyError(new Error("Invalid model ID: nope"))).toBe(
      "invalid_model",
    );
    expect(classifyError(new Error("Request timed out"))).toBe(
      "provider_timeout",
    );
    expect(classifyError(new Error("fetch failed"))).toBe("network");
    expect(
      classifyError(Object.assign(new Error("x"), { code: "ENOENT" })),
    ).toBe("filesystem");
    expect(classifyError(new Error("something weird"))).toBe("agent_error");
  });

  test("never returns the raw message", () => {
    const secret = "token=/Users/me/.openwiki/secret-value";
    const result = classifyError(new Error(secret));

    expect(result).toBe("agent_error");
    expect(result).not.toContain("secret");
  });
});

describe("gates", () => {
  test("isTelemetryDisabled honors both vars and the falsy set", () => {
    expect(isTelemetryDisabled()).toBe(false);

    process.env.OPENWIKI_TELEMETRY_DISABLED = "1";
    expect(isTelemetryDisabled()).toBe(true);
    delete process.env.OPENWIKI_TELEMETRY_DISABLED;

    process.env.DO_NOT_TRACK = "true";
    expect(isTelemetryDisabled()).toBe(true);
    delete process.env.DO_NOT_TRACK;

    for (const falsy of ["0", "false", ""]) {
      process.env.OPENWIKI_TELEMETRY_DISABLED = falsy;
      expect(isTelemetryDisabled()).toBe(false);
    }
  });

  test("isCiEnvironment: ci-info OR the scheduled escape hatch", () => {
    expect(isCiEnvironment()).toBe(false);

    ci.isCI = true;
    expect(isCiEnvironment()).toBe(true);
    ci.isCI = false;

    process.env.OPENWIKI_SCHEDULED = "1";
    expect(isCiEnvironment()).toBe(true);
  });

  test("ciSentinelId slugs the provider name", () => {
    ci.name = "GitHub Actions";
    expect(ciSentinelId()).toBe("ci-github-actions");
    ci.name = "Travis CI";
    expect(ciSentinelId()).toBe("ci-travis-ci");
    ci.name = null;
    expect(ciSentinelId()).toBe("ci-unknown");
  });

  test("noticeSuppressed is opt-out OR ci", () => {
    expect(noticeSuppressed()).toBe(false);
    ci.isCI = true;
    expect(noticeSuppressed()).toBe(true);
    ci.isCI = false;
    process.env.OPENWIKI_TELEMETRY_DISABLED = "1";
    expect(noticeSuppressed()).toBe(true);
  });
});

describe("client.capture", () => {
  test("sets the minimal-collection flags and never sends an IP", async () => {
    const sent = await captureEvent({
      distinctId: "id-1",
      event: "openwiki_run",
      properties: { command: "init" },
    });

    expect(sent).toBe(true);
    expect(posthog.PostHog).toHaveBeenCalledWith(
      DEFAULT_POSTHOG_KEY,
      expect.objectContaining({ isServer: false }),
    );

    const arg = posthog.captureImmediate.mock.calls[0]?.[0] as {
      disableGeoip?: boolean;
      properties: Record<string, unknown>;
    };
    expect(arg.disableGeoip).toBe(true);
    // The client passes properties through untouched; the person-profile flag
    // is set per-event by `send`, not here.
    expect(arg.properties).not.toHaveProperty("$process_person_profile");
    expect(arg.properties).not.toHaveProperty("$ip");
    expect(posthog.shutdown).toHaveBeenCalledOnce();
  });
});

describe("senders.recordRun", () => {
  test("opt-out sends nothing and tees a disabled marker", async () => {
    process.env.OPENWIKI_TELEMETRY_DISABLED = "1";
    const file = path.join(tmpdir(), "ow-tel-optout.json");

    await recordRun(runDetails({ telemetryFile: file }));

    const tee = await readTee(file);
    expect(tee).toMatchObject({ disabled: true, sent: false });
    expect(posthog.captureImmediate).not.toHaveBeenCalled();
    await rm(file, { force: true });
  });

  test("human run uses the install id, ci=false, profile off", async () => {
    const file = path.join(tmpdir(), "ow-tel-normal.json");

    await recordRun(runDetails({ telemetryFile: file }));

    const tee = (await readTee(file)) as {
      ci: boolean;
      sent: boolean;
      event: {
        distinctId: string;
        properties: { ci: boolean; $process_person_profile: boolean };
      };
    };
    expect(tee.ci).toBe(false);
    expect(tee.sent).toBe(true);
    expect(tee.event.distinctId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(tee.event.properties.ci).toBe(false);
    // Every run is anonymous: no person profile is ever created.
    expect(tee.event.properties.$process_person_profile).toBe(false);
    expect(posthog.captureImmediate).toHaveBeenCalledOnce();
    await rm(file, { force: true });
  });

  test("CI run uses the sentinel id, ci=true, profile off", async () => {
    process.env.OPENWIKI_SCHEDULED = "1";
    const file = path.join(tmpdir(), "ow-tel-ci.json");

    await recordRun(runDetails({ telemetryFile: file }));

    const tee = (await readTee(file)) as {
      ci: boolean;
      event: {
        distinctId: string;
        properties: { ci: boolean; $process_person_profile: boolean };
      };
    };
    expect(tee.ci).toBe(true);
    expect(tee.event.distinctId).toBe("ci-unknown");
    expect(tee.event.properties.ci).toBe(true);
    // CI stays anonymous (no person profile).
    expect(tee.event.properties.$process_person_profile).toBe(false);
    await rm(file, { force: true });
  });

  test("never throws even if capture fails", async () => {
    posthog.captureImmediate.mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(recordRun(runDetails())).resolves.toBeUndefined();
  });
});

describe("getConfiguredConnectorIds", () => {
  test("reports only auth-gated, fully-configured connectors", () => {
    expect(getConfiguredConnectorIds()).not.toContain("notion");
    // Zero-auth built-ins never count as adoption signal.
    expect(getConfiguredConnectorIds()).not.toContain("git-repo");
    expect(getConfiguredConnectorIds()).not.toContain("hackernews");

    process.env.OPENWIKI_NOTION_MCP_ACCESS_TOKEN = "secret";
    expect(getConfiguredConnectorIds()).toContain("notion");
  });
});

describe("recordRun connector properties", () => {
  function runEvent(): { event: string; properties: Record<string, unknown> } {
    return posthog.captureImmediate.mock.calls[0]?.[0] as {
      event: string;
      properties: Record<string, unknown>;
    };
  }

  test("configured connectors become boolean connector_<id> properties", async () => {
    await recordRun(
      runDetails({ configuredConnectors: ["web-search", "notion"] }),
    );

    const arg = runEvent();
    expect(arg.event).toBe("openwiki_run");
    // Hyphens are normalized to underscores; only configured ones appear.
    expect(arg.properties).toMatchObject({
      connector_web_search: true,
      connector_notion: true,
    });
    expect(arg.properties).not.toHaveProperty("connector_slack");
  });

  test("no connector_ properties when nothing is configured", async () => {
    await recordRun(runDetails({ configuredConnectors: [] }));

    const props = runEvent().properties;
    expect(Object.keys(props).some((key) => key.startsWith("connector_"))).toBe(
      false,
    );
  });

  test("stamps production=false when running from source (dev/test)", async () => {
    // Tests import from src/, so isProductionBuild() (dist/ check) is false;
    // the published build runs from dist/ and would send production=true.
    await recordRun(runDetails());

    expect(runEvent().properties.production).toBe(false);
  });

  test("update runs omit the init-only setup fields", async () => {
    // The agent only sets mode/provider/connectors on init; an update payload
    // built without them must not carry mode/provider/connector_ properties.
    await recordRun({ command: "update", outcome: "success" });

    const props = runEvent().properties;
    expect(props).not.toHaveProperty("mode");
    expect(props).not.toHaveProperty("provider");
    expect(Object.keys(props).some((key) => key.startsWith("connector_"))).toBe(
      false,
    );
    expect(props).toMatchObject({ command: "update", outcome: "success" });
  });
});
