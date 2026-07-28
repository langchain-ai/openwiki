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

import { PROVIDER_CONFIGS } from "../src/constants.ts";
import { getConfiguredConnectorIds } from "../src/connectors/registry.ts";
import { capture as captureEvent } from "../src/telemetry/client.ts";
import { DEFAULT_POSTHOG_KEY } from "../src/telemetry/config.ts";
import {
  classifyError,
  describeErrorForTelemetry,
  inStage,
  inStageSync,
  tagErrorStage,
} from "../src/telemetry/errors.ts";
import {
  deriveOwner,
  normalizeErrorDetail,
} from "../src/telemetry/taxonomy.ts";
import {
  ciSentinelId,
  isCiEnvironment,
  isTelemetryDisabled,
  noticeSuppressed,
} from "../src/telemetry/gates.ts";
import { buildRunEvent, recordRun } from "../src/telemetry/senders.ts";
import type { RunEventContext } from "../src/telemetry/senders.ts";
import type {
  RunTelemetry,
  TelemetryErrorClass,
  TelemetryErrorStage,
  TelemetryEvent,
} from "../src/telemetry/types.ts";

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
  test("maps known shapes to family and detail", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";

    expect(classifyError(abort)).toEqual({ errorClass: "aborted" });
    expect(classifyError({ status: 401 })).toEqual({
      errorClass: "provider_error",
      errorDetail: "auth",
    });
    expect(classifyError({ status: 403 })).toEqual({
      errorClass: "provider_error",
      errorDetail: "auth",
    });
    expect(classifyError({ statusCode: 429 })).toEqual({
      errorClass: "provider_error",
      errorDetail: "rate_limit",
    });
    expect(
      classifyError(new Error("OPENAI_API_KEY is required to run OpenWiki.")),
    ).toEqual({
      errorClass: "config_error",
      errorDetail: "missing_credentials",
    });
    expect(
      classifyError(new Error("A base URL is required to run OpenWiki.")),
    ).toEqual({ errorClass: "config_error", errorDetail: "missing_base_url" });
    expect(classifyError(new Error("Invalid model ID: nope"))).toEqual({
      errorClass: "config_error",
      errorDetail: "invalid_model",
    });
    expect(classifyError(new Error("Request timed out"))).toEqual({
      errorClass: "provider_error",
      errorDetail: "timeout",
    });
    expect(classifyError(new Error("fetch failed"))).toEqual({
      errorClass: "network_error",
      errorDetail: "unreachable",
    });
    expect(
      classifyError(Object.assign(new Error("x"), { code: "ENOENT" })),
    ).toEqual({ errorClass: "filesystem_error", errorDetail: "not_found" });
    expect(classifyError(new Error("something weird"))).toEqual({
      errorClass: "agent_error",
    });
  });

  test("never returns the raw message", () => {
    const secret = "token=/Users/me/.openwiki/secret-value";
    const result = classifyError(new Error(secret));

    expect(result).toEqual({ errorClass: "agent_error" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("classifyError - provider granularity", () => {
  test("a recognized provider code wins over the status", () => {
    expect(
      classifyError({ status: 400, code: "context_length_exceeded" }),
    ).toEqual({ errorClass: "context_limit_error" });
  });

  test("maps the new statuses to provider_error details", () => {
    expect(classifyError({ status: 529 })).toEqual({
      errorClass: "provider_error",
      errorDetail: "overloaded",
    });
    expect(classifyError({ status: 503 })).toEqual({
      errorClass: "provider_error",
      errorDetail: "overloaded",
    });
    expect(classifyError({ status: 500 })).toEqual({
      errorClass: "provider_error",
      errorDetail: "server_error",
    });
  });

  test("reads a nested response.status", () => {
    expect(classifyError({ response: { status: 503 } })).toEqual({
      errorClass: "provider_error",
      errorDetail: "overloaded",
    });
  });

  test("classifies context limit and content filter by message", () => {
    expect(
      classifyError(new Error("maximum context length is 200000 tokens")),
    ).toEqual({ errorClass: "context_limit_error" });
    expect(classifyError(new Error("Blocked by content policy"))).toEqual({
      errorClass: "provider_error",
      errorDetail: "content_filter",
    });
  });

  test("splits network detail by the underlying code", () => {
    expect(
      classifyError(new Error("getaddrinfo ENOTFOUND api.provider.com")),
    ).toEqual({ errorClass: "network_error", errorDetail: "dns" });
    expect(
      classifyError(new Error("connect ECONNREFUSED 127.0.0.1:443")),
    ).toEqual({ errorClass: "network_error", errorDetail: "refused" });
  });

  test("folds any unclassified throw into agent_error", () => {
    expect(classifyError(new Error("something weird"))).toEqual({
      errorClass: "agent_error",
    });
    expect(classifyError("boom")).toEqual({ errorClass: "agent_error" });
    expect(classifyError(undefined)).toEqual({ errorClass: "agent_error" });
  });
});

describe("taxonomy", () => {
  test("deriveOwner encodes the default owners", () => {
    expect(deriveOwner("config_error", "missing_credentials", "config")).toBe(
      "environment",
    );
    expect(deriveOwner("context_limit_error", undefined, "run")).toBe(
      "openwiki",
    );
    expect(deriveOwner("build_error", "snapshot", "build")).toBe("openwiki");
    expect(deriveOwner("provider_error", "rate_limit", "run")).toBe("provider");
    expect(deriveOwner("network_error", "reset", "run")).toBe("provider");
    expect(deriveOwner("agent_error", undefined, undefined)).toBe("unowned");
    expect(deriveOwner("aborted", undefined, undefined)).toBe("control");
  });

  test("deriveOwner encodes the cross-owner exceptions", () => {
    expect(deriveOwner("provider_error", "auth", "run")).toBe("environment");
    expect(deriveOwner("provider_error", "quota_exceeded", "run")).toBe(
      "environment",
    );
    expect(deriveOwner("network_error", "dns", "run")).toBe("environment");
    expect(deriveOwner("network_error", "refused", "run")).toBe("environment");
    expect(deriveOwner("filesystem_error", "permission", "finalize")).toBe(
      "openwiki",
    );
    expect(deriveOwner("filesystem_error", "permission", "build")).toBe(
      "environment",
    );
  });

  test("normalizeErrorDetail drops anything off the family allowlist", () => {
    expect(normalizeErrorDetail("provider_error", "auth")).toBe("auth");
    expect(
      normalizeErrorDetail("provider_error", "not_a_detail"),
    ).toBeUndefined();
    // A family with no detail split never emits one.
    expect(
      normalizeErrorDetail("context_limit_error", "anything"),
    ).toBeUndefined();
    // Open families trust a registry id (validated at the tag site).
    expect(normalizeErrorDetail("connector_error", "langsmith")).toBe(
      "langsmith",
    );
    expect(normalizeErrorDetail("tool_error", "read_file")).toBe("read_file");
  });
});

describe("error origin tags", () => {
  test("first stage tag wins and never serializes", () => {
    const error = new Error("x");
    tagErrorStage(error, "build");
    tagErrorStage(error, "run");

    expect(describeErrorForTelemetry(error).errorStage).toBe("build");
    expect(JSON.stringify(error)).not.toMatch(/build/u);
  });

  test("an untagged error reports no stage", () => {
    expect(
      describeErrorForTelemetry(new Error("x")).errorStage,
    ).toBeUndefined();
  });

  test("an origin tag supplies the owned family class and detail", async () => {
    const captured = await inStage(
      "run",
      () => {
        throw new Error("index write failed");
      },
      { errorClass: "okf_error", errorDetail: "index_sync" },
    ).catch((error: unknown) => error);

    expect(describeErrorForTelemetry(captured)).toMatchObject({
      errorClass: "okf_error",
      errorDetail: "index_sync",
      errorStage: "run",
      errorOwner: "openwiki",
    });
  });

  test("an off-allowlist origin detail is dropped, not emitted", async () => {
    const captured = await inStage(
      "build",
      () => {
        throw new Error("x");
      },
      { errorClass: "build_error", errorDetail: "totally_made_up" },
    ).catch((error: unknown) => error);

    const described = describeErrorForTelemetry(captured);
    expect(described.errorClass).toBe("build_error");
    expect(described.errorDetail).toBeUndefined();
  });

  test("assembles class, detail, owner, stage, and status", () => {
    const error = Object.assign(new Error("nope"), { status: 503 });
    tagErrorStage(error, "run");

    expect(describeErrorForTelemetry(error)).toEqual({
      errorClass: "provider_error",
      errorDetail: "overloaded",
      errorStage: "run",
      errorOwner: "provider",
      httpStatus: 503,
    });
  });

  test("owner exception: a provider auth failure owns to environment", () => {
    const error = Object.assign(new Error("unauthorized"), { status: 401 });

    expect(describeErrorForTelemetry(error)).toMatchObject({
      errorClass: "provider_error",
      errorDetail: "auth",
      errorOwner: "environment",
    });
  });

  test("leaves detail, stage, and status undefined when absent", () => {
    expect(describeErrorForTelemetry(new Error("boom"))).toEqual({
      errorClass: "agent_error",
      errorDetail: undefined,
      errorStage: undefined,
      errorOwner: "unowned",
      httpStatus: undefined,
    });
  });
});

describe("owned-family origins tagged at their throw sites", () => {
  // Each row is an origin actually stamped in the run pipeline (build steps in
  // runOpenWikiAgentCore, the checkpointer create/chmod sites, and the OKF
  // middleware passes). The test guards the seam between the throw site and the
  // taxonomy: a detail typo, or one missing from its family's allowlist, would be
  // silently dropped by normalizeErrorDetail, so asserting the detail survives is
  // what catches a divergence between where we tag and what taxonomy.ts permits.
  const origins: Array<{
    errorClass: TelemetryErrorClass;
    errorDetail: string;
    errorStage: TelemetryErrorStage;
  }> = [
    {
      errorClass: "build_error",
      errorDetail: "run_context",
      errorStage: "build",
    },
    { errorClass: "build_error", errorDetail: "snapshot", errorStage: "build" },
    { errorClass: "build_error", errorDetail: "model", errorStage: "build" },
    { errorClass: "build_error", errorDetail: "agent", errorStage: "build" },
    {
      errorClass: "build_error",
      errorDetail: "stream_open",
      errorStage: "build",
    },
    {
      errorClass: "checkpointer_error",
      errorDetail: "create",
      errorStage: "build",
    },
    {
      errorClass: "checkpointer_error",
      errorDetail: "chmod",
      errorStage: "finalize",
    },
    { errorClass: "okf_error", errorDetail: "migrate", errorStage: "build" },
    { errorClass: "okf_error", errorDetail: "mermaid", errorStage: "finalize" },
    {
      errorClass: "okf_error",
      errorDetail: "index_sync",
      errorStage: "finalize",
    },
  ];

  test.each(origins)(
    "$errorClass/$errorDetail at $errorStage keeps its detail and owns to openwiki",
    ({ errorClass, errorDetail, errorStage }) => {
      let captured: unknown;
      try {
        inStageSync(
          errorStage,
          () => {
            throw new Error("boom");
          },
          { errorClass, errorDetail },
        );
      } catch (error) {
        captured = error;
      }

      expect(describeErrorForTelemetry(captured)).toMatchObject({
        errorClass,
        errorDetail,
        errorStage,
        errorOwner: "openwiki",
      });
    },
  );
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

describe("buildRunEvent diagnostics", () => {
  const baseContext: RunEventContext = {
    ci: false,
    production: true,
    distinctId: "install-abc",
  };

  test("failure diagnostics ride the payload", () => {
    // A failure with a tagged stage, a detail, an owner, and a provider status
    // must surface all of them, alongside the class, as flat anonymous properties.
    const event = buildRunEvent(
      {
        command: "init",
        outcome: "failure",
        errorClass: "provider_error",
        errorDetail: "overloaded",
        errorOwner: "provider",
        errorStage: "run",
        httpStatus: 529,
      },
      baseContext,
    );

    expect(event.properties).toMatchObject({
      error_class: "provider_error",
      error_detail: "overloaded",
      error_owner: "provider",
      error_stage: "run",
      http_status: 529,
    });
  });

  test("success omits every failure diagnostic", () => {
    // No failure means no diagnostics: the fields must be absent, not null/0,
    // so the PostHog null bucket stays meaningful.
    const event = buildRunEvent(
      { command: "init", outcome: "success" },
      baseContext,
    );

    expect(event.properties).not.toHaveProperty("error_class");
    expect(event.properties).not.toHaveProperty("error_detail");
    expect(event.properties).not.toHaveProperty("error_owner");
    expect(event.properties).not.toHaveProperty("error_stage");
    expect(event.properties).not.toHaveProperty("http_status");
  });

  test("http_status of 0 would still ride, but omission is by undefined only", () => {
    // Guard the `!== undefined` check: a (hypothetical) zero status is a real
    // value and must not be dropped by a falsy test.
    const event = buildRunEvent(
      {
        command: "init",
        outcome: "failure",
        errorClass: "agent_error",
        httpStatus: 0,
      },
      baseContext,
    );

    expect(event.properties.http_status).toBe(0);
  });

  test("app_version is stamped when the context supplies it", () => {
    // app_version is a peer of production/ci and rides every event (init or
    // update) when the caller resolved it.
    const event = buildRunEvent(
      { command: "update", outcome: "success" },
      { ...baseContext, appVersion: "9.9.9" },
    );

    expect(event.properties).toMatchObject({ app_version: "9.9.9" });
  });

  test("app_version is omitted when the context could not resolve it", () => {
    // A failed package.json read leaves appVersion undefined; the field must
    // simply not appear rather than send an empty string.
    const event = buildRunEvent(
      { command: "init", outcome: "success" },
      baseContext,
    );

    expect(event.properties).not.toHaveProperty("app_version");
  });
});

describe("anonymity envelope: one representative failure per reachable family", () => {
  // The closed value sets a property may carry. These are an independent
  // restatement of the taxonomy (types.ts unions, taxonomy.ts allowlists): the
  // point of an anonymity guard is that widening what leaves the process must be
  // consciously mirrored here, so a raw string sneaking into any property fails
  // its key's check and an entirely new key trips the `default` throw below.
  const ENUM_ALLOWLISTS: Readonly<Record<string, ReadonlySet<string>>> = {
    command: new Set(["init", "update"]),
    outcome: new Set(["success", "failure", "noop"]),
    error_class: new Set([
      "config_error",
      "filesystem_error",
      "provider_error",
      "network_error",
      "context_limit_error",
      "build_error",
      "connector_error",
      "okf_error",
      "checkpointer_error",
      "tool_error",
      "output_error",
      "agent_error",
      "aborted",
    ]),
    error_owner: new Set([
      "environment",
      "provider",
      "openwiki",
      "unowned",
      "control",
    ]),
    error_stage: new Set(["config", "build", "run", "finalize"]),
    mode: new Set(["code", "personal"]),
  };

  // The union of every fixed family's detail allowlist (taxonomy.ts
  // FIXED_ERROR_DETAILS). A deliberate second copy: normalizeErrorDetail is the
  // runtime gate, and this is the test-side contract it must not outgrow.
  const DETAIL_ALLOWLIST: ReadonlySet<string> = new Set([
    "missing_credentials",
    "missing_base_url",
    "missing_secret_key",
    "missing_region",
    "invalid_model",
    "not_found",
    "permission",
    "no_space",
    "auth",
    "rate_limit",
    "overloaded",
    "server_error",
    "timeout",
    "quota_exceeded",
    "content_filter",
    "dns",
    "refused",
    "reset",
    "unreachable",
    "run_context",
    "snapshot",
    "model",
    "agent",
    "stream_open",
    "migrate",
    "index_sync",
    "mermaid",
    "create",
    "persist",
    "chmod",
    "json_parse",
    "schema",
  ]);

  // Provider is the one free-ish string that rides an init event; it must be a
  // known registry key or the "unknown" fallback recordRunSafe substitutes when
  // resolution failed before the provider was known.
  const PROVIDER_ALLOWLIST: ReadonlySet<string> = new Set([
    ...Object.keys(PROVIDER_CONFIGS),
    "unknown",
  ]);

  const sweepContext: RunEventContext = {
    ci: false,
    production: true,
    // An anonymous install UUID, exactly the shape recordRun attributes to.
    distinctId: "0f9a2c1e-4b3d-4e5f-8a1b-2c3d4e5f6a7b",
    appVersion: "0.2.3",
  };

  /**
   * Asserts the entire event is inside the anonymity envelope: an anonymous
   * identity, the one known event name, and every property either a closed enum,
   * a bare integer, a boolean, or an allowlisted word. The `default` branch turns
   * any unrecognized key into a failure, so this doubles as the "keys are a subset
   * of the allowed set" guarantee.
   */
  function assertAnonymousEnvelope(event: TelemetryEvent): void {
    // Never a name, email, or path: only an install UUID or a CI sentinel slug.
    expect(event.distinctId).toMatch(/^[0-9a-f-]{36}$|^ci-[a-z0-9-]+$/u);
    expect(event.event).toBe("openwiki_run");

    for (const [key, value] of Object.entries(event.properties)) {
      // Connector adoption booleans: the id is registry-derived (the same closed
      // set as the configured-connector list), and the value is literally `true`.
      if (key.startsWith("connector_")) {
        expect(value).toBe(true);
        continue;
      }

      switch (key) {
        case "command":
        case "outcome":
        case "error_class":
        case "error_owner":
        case "error_stage":
        case "mode":
          expect(ENUM_ALLOWLISTS[key].has(value as string)).toBe(true);
          break;
        case "error_detail":
          expect(DETAIL_ALLOWLIST.has(value as string)).toBe(true);
          break;
        case "provider":
          expect(PROVIDER_ALLOWLIST.has(value as string)).toBe(true);
          break;
        case "http_status":
          // A bare integer; no provider strings ride with it.
          expect(Number.isInteger(value)).toBe(true);
          break;
        case "app_version":
          expect(value).toMatch(/^\d+\.\d+\.\d+/u);
          break;
        case "production":
        case "ci":
        case "$process_person_profile":
          expect(typeof value).toBe("boolean");
          break;
        default:
          throw new Error(`unexpected telemetry property "${key}"`);
      }
    }
  }

  /**
   * Runs a synchronous throw through {@link inStageSync} so the error carries the
   * origin tag an owned-family throw site would stamp, then returns it — the same
   * path production takes before the failure reaches describeErrorForTelemetry.
   */
  function tagged(
    stage: TelemetryErrorStage,
    origin: { errorClass: TelemetryErrorClass; errorDetail: string },
  ): unknown {
    try {
      inStageSync(
        stage,
        () => {
          throw new Error("boom");
        },
        origin,
      );
    } catch (error) {
      return error;
    }
    throw new Error("expected the staged fn to throw");
  }

  // One representative failure per family that a run can actually produce, built
  // the way production builds it: a raw error the classifier reads, or a throw
  // carrying the origin tag its owned-family site stamps. `connector_error` and
  // `tool_error` are intentionally absent — they have no fatal propagating path
  // (connector pulls are fail-open; tool throws are swallowed into ToolMessages),
  // so a "representative failure" for them cannot exist to sweep.
  const FAILURE_FIXTURES: ReadonlyArray<{
    family: TelemetryErrorClass;
    label: string;
    makeError: () => unknown;
  }> = [
    {
      family: "config_error",
      label: "a missing-credentials config error",
      makeError: () => new Error("OPENAI_API_KEY is required to run OpenWiki."),
    },
    {
      family: "filesystem_error",
      label: "a filesystem ENOENT",
      makeError: () =>
        Object.assign(new Error("open failed"), { code: "ENOENT" }),
    },
    {
      family: "provider_error",
      label: "a 401 provider auth failure",
      makeError: () => ({ status: 401 }),
    },
    {
      family: "network_error",
      label: "a DNS lookup failure",
      makeError: () => new Error("getaddrinfo ENOTFOUND api.provider.com"),
    },
    {
      family: "context_limit_error",
      label: "a context-length provider code",
      makeError: () => ({ status: 400, code: "context_length_exceeded" }),
    },
    {
      family: "build_error",
      label: "a tagged model-build failure",
      makeError: () =>
        tagged("build", { errorClass: "build_error", errorDetail: "model" }),
    },
    {
      family: "checkpointer_error",
      label: "a tagged checkpointer create failure",
      makeError: () =>
        tagged("build", {
          errorClass: "checkpointer_error",
          errorDetail: "create",
        }),
    },
    {
      family: "okf_error",
      label: "a tagged OKF index-sync failure",
      makeError: () =>
        tagged("finalize", {
          errorClass: "okf_error",
          errorDetail: "index_sync",
        }),
    },
    {
      family: "output_error",
      label: "a JSON parse failure",
      makeError: () => new Error("could not parse JSON output"),
    },
    {
      family: "agent_error",
      label: "an unclassified throw",
      makeError: () => new Error("something weird happened"),
    },
    {
      family: "aborted",
      label: "a user abort",
      makeError: () =>
        Object.assign(new Error("aborted"), { name: "AbortError" }),
    },
  ];

  test.each(FAILURE_FIXTURES)(
    "$family ($label) resolves its class and stays inside the envelope",
    ({ family, makeError }) => {
      const described = describeErrorForTelemetry(makeError());
      const event = buildRunEvent(
        {
          command: "init",
          outcome: "failure",
          mode: "personal",
          provider: "anthropic",
          configuredConnectors: ["web-search"],
          errorClass: described.errorClass,
          errorDetail: described.errorDetail,
          errorOwner: described.errorOwner,
          errorStage: described.errorStage,
          httpStatus: described.httpStatus,
        },
        sweepContext,
      );

      // The classifier/tag wiring resolved the family we forced end-to-end...
      expect(event.properties.error_class).toBe(family);
      // ...and the whole assembled payload is anonymous.
      assertAnonymousEnvelope(event);
    },
  );

  test("a successful init stays inside the envelope", () => {
    const event = buildRunEvent(
      runDetails({ outcome: "success" }),
      sweepContext,
    );
    assertAnonymousEnvelope(event);
  });

  test("a noop update stays inside the envelope", () => {
    const event = buildRunEvent(
      { command: "update", outcome: "noop" },
      sweepContext,
    );
    assertAnonymousEnvelope(event);
  });
});
