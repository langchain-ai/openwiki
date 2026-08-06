import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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

import { PROVIDER_CONFIGS } from "../../src/config/constants.ts";
import { getConfiguredConnectorIds } from "../../src/connectors/registry.ts";
import { capture as captureEvent } from "../../src/telemetry/client.ts";
import { DEFAULT_POSTHOG_KEY } from "../../src/telemetry/config.ts";
import {
  classifyError,
  describeErrorForTelemetry,
  firstStatusInChain,
  inStage,
  inStageSync,
  safeConstructorName,
  safeErrorName,
  tagErrorStage,
  unwrapErrorChain,
} from "../../src/telemetry/errors.ts";
import {
  deriveOwner,
  isSafeErrorIdentifier,
  normalizeErrorDetail,
} from "../../src/telemetry/taxonomy.ts";
import {
  buildChannel,
  ciSentinelId,
  isCiEnvironment,
  isTelemetryDisabled,
  noticeSuppressed,
} from "../../src/telemetry/gates.ts";
import { buildRunEvent, recordRun } from "../../src/telemetry/senders.ts";
import type { RunEventContext } from "../../src/telemetry/senders.ts";
import type {
  RunTelemetry,
  TelemetryErrorClass,
  TelemetryErrorStage,
  TelemetryEvent,
} from "../../src/telemetry/types.ts";

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
  vi.useRealTimers();
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

describe("classifyError - unwrapping wrapped errors", () => {
  test("recovers a provider status from a cause chain", () => {
    // The top-level wrapper carries no status; the real signal is one `cause`
    // deep. This is the tool-error-wrapping-a-429 shape that today falls through.
    const wrapped = new Error("tool failed");
    (wrapped as { cause?: unknown }).cause = { status: 429 };

    expect(classifyError(wrapped)).toEqual({
      errorClass: "provider_error",
      errorDetail: "rate_limit",
    });
  });

  test("recovers a signal from AggregateError.errors", () => {
    // Parallel subagents can surface as an AggregateError; the classifiable link
    // is inside the `errors` array, not on the aggregate itself.
    const aggregate = new AggregateError(
      [new Error("wrapper"), new Error("getaddrinfo ENOTFOUND api.host")],
      "all failed",
    );

    expect(classifyError(aggregate)).toEqual({
      errorClass: "network_error",
      errorDetail: "dns",
    });
  });

  test("nearest classifiable link wins over a deeper one", () => {
    // A 401 wrapping a 429 classifies as auth: the walk is nearest-first, so the
    // outer recognized signal is returned before the inner one is reached.
    const outer = Object.assign(new Error("auth wrapper"), { status: 401 });
    (outer as { cause?: unknown }).cause = { status: 429 };

    expect(classifyError(outer)).toEqual({
      errorClass: "provider_error",
      errorDetail: "auth",
    });
  });

  test("terminates on a cyclic cause chain and returns the residual", () => {
    // A self-referential cause must not hang the walk; with no signal it stays
    // residual.
    const cyclic = new Error("loop");
    (cyclic as { cause?: unknown }).cause = cyclic;

    expect(classifyError(cyclic)).toEqual({ errorClass: "agent_error" });
  });

  test("stops at the depth bound: a signal below it is not reached", () => {
    // A run of wrappers longer than MAX_UNWRAP_DEPTH (32) puts the only real signal
    // (a 429) past the bound, so the walk bounds out at the residual rather than
    // recovering it. This is the DoS guard: a pathologically deep chain costs at
    // most the bounded number of links.
    let deep: { message: string; cause?: unknown } = { message: "w0" };
    const root = deep;
    for (let i = 1; i <= 40; i++) {
      const next = { message: `w${i}` };
      deep.cause = next;
      deep = next;
    }
    deep.cause = { status: 429 };

    expect(classifyError(root)).toEqual({ errorClass: "agent_error" });
  });

  test("a signal within the depth bound is still recovered", () => {
    // The same shape but with the 429 at depth 3 is found: the bound only drops
    // signals genuinely past five links.
    const l0 = new Error("w0");
    const l1 = new Error("w1");
    const l2 = { status: 429 };
    (l0 as { cause?: unknown }).cause = l1;
    (l1 as { cause?: unknown }).cause = l2;

    expect(classifyError(l0)).toEqual({
      errorClass: "provider_error",
      errorDetail: "rate_limit",
    });
  });

  test("an unwrapped error still classifies exactly as before", () => {
    // A chain of length one must behave identically to the pre-unwrap classifier.
    expect(classifyError({ status: 401 })).toEqual({
      errorClass: "provider_error",
      errorDetail: "auth",
    });
    expect(classifyError(new Error("nothing recognizable"))).toEqual({
      errorClass: "agent_error",
    });
  });

  test("unwrapErrorChain is read-only, cycle-safe, and depth-bounded", () => {
    const cyclic = new Error("a");
    (cyclic as { cause?: unknown }).cause = cyclic;

    const chain = unwrapErrorChain(cyclic);
    // Never longer than the bound, even for a cycle.
    expect(chain.length).toBeLessThanOrEqual(5);
    // The first link is always the original value.
    expect(chain[0]).toBe(cyclic);
    // A thrown non-object is still the sole link, so classification is unchanged.
    expect(unwrapErrorChain("boom")).toEqual(["boom"]);
  });
});

describe("safeConstructorName allowlist", () => {
  test("accepts a plain ASCII constructor name", () => {
    expect(safeConstructorName(new TypeError("x"))).toBe("TypeError");
    expect(safeConstructorName(new Error("x"))).toBe("Error");
  });

  test("reads the prototype, ignoring a tampered own constructor", () => {
    // An own `constructor` property must not smuggle a value past the allowlist:
    // the name comes from the prototype chain (here, Object), not the own prop.
    const tampered = { constructor: { name: "PwnedError/../etc" } };

    expect(safeConstructorName(tampered)).toBe("Object");
  });

  test("drops names that are not bare identifiers", () => {
    const withName = (name: string): unknown => {
      class Custom {}
      Object.defineProperty(Custom, "name", { value: name });
      return new Custom();
    };

    expect(safeConstructorName(withName("has space"))).toBeUndefined();
    expect(safeConstructorName(withName("a/b"))).toBeUndefined();
    expect(
      safeConstructorName(withName("/Users/me/secret/path")),
    ).toBeUndefined();
    expect(safeConstructorName(withName("a".repeat(65)))).toBeUndefined();
    // A 64-char identifier is the longest allowed and still passes.
    expect(safeConstructorName(withName("a".repeat(64)))).toBe("a".repeat(64));
    // Interior underscores are allowed (real SDK error names carry them), but a
    // leading, trailing, or doubled underscore is not a bare identifier.
    expect(safeConstructorName(withName("AI_APICallError"))).toBe(
      "AI_APICallError",
    );
    expect(safeConstructorName(withName("_leading"))).toBeUndefined();
    expect(safeConstructorName(withName("trailing_"))).toBeUndefined();
    expect(safeConstructorName(withName("double__underscore"))).toBeUndefined();
  });

  test("non-objects have no constructor name", () => {
    expect(safeConstructorName("string")).toBeUndefined();
    expect(safeConstructorName(42)).toBeUndefined();
    expect(safeConstructorName(null)).toBeUndefined();
    expect(safeConstructorName(undefined)).toBeUndefined();
  });
});

describe("safeErrorName allowlist", () => {
  test("reads the deliberately-set .name a framework copies up", () => {
    // LangChain's MiddlewareError copies the inner error's .name onto the wrapper,
    // so .name names the real failure even when the constructor is the envelope.
    const wrapper = Object.assign(new Error("wrapModelCall failed"), {
      name: "AI_APICallError",
    });

    expect(safeErrorName(wrapper)).toBe("AI_APICallError");
    // A stock Error's .name is its constructor name, so both agree.
    expect(safeErrorName(new TypeError("x"))).toBe("TypeError");
  });

  test("drops a .name that is not a bare identifier", () => {
    const tampered = Object.assign(new Error("x"), {
      name: "/Users/me/secret error",
    });

    expect(safeErrorName(tampered)).toBeUndefined();
  });

  test("non-objects and nameless objects yield undefined", () => {
    expect(safeErrorName("string")).toBeUndefined();
    expect(safeErrorName(null)).toBeUndefined();
    expect(safeErrorName({})).toBeUndefined();
  });
});

describe("isSafeErrorIdentifier", () => {
  test("accepts bare identifiers with interior underscores, rejects the rest", () => {
    expect(isSafeErrorIdentifier("TypeError")).toBe(true);
    expect(isSafeErrorIdentifier("OUTPUT_PARSING_FAILURE")).toBe(true);
    expect(isSafeErrorIdentifier("a".repeat(64))).toBe(true);
    expect(isSafeErrorIdentifier("a".repeat(65))).toBe(false);
    expect(isSafeErrorIdentifier("has space")).toBe(false);
    expect(isSafeErrorIdentifier("_leading")).toBe(false);
    expect(isSafeErrorIdentifier("")).toBe(false);
    expect(isSafeErrorIdentifier(42)).toBe(false);
  });
});

describe("describeErrorForTelemetry - residual fingerprint", () => {
  test("a residual failure carries its name as error_detail and no status", () => {
    const described = describeErrorForTelemetry(new TypeError("boom"));

    expect(described.errorClass).toBe("agent_error");
    expect(described.errorDetail).toBe("TypeError");
    expect(described.httpStatus).toBeUndefined();
  });

  test("a named class carries its family detail, not a name fingerprint", () => {
    // The fingerprint only rides for the residual bucket; a real 401 is already
    // named, so its detail is the taxonomy word, not the error's constructor.
    const described = describeErrorForTelemetry({ status: 401 });

    expect(described.errorClass).toBe("provider_error");
    expect(described.errorDetail).toBe("auth");
  });

  test("fingerprints the innermost cause's name, not the outer wrapper", () => {
    // A framework envelope (e.g. LangChain's MiddlewareError) copies the inner
    // message onto a fresh wrapper but reports its own constructor. The fingerprint
    // must reach the real cause so the residual bucket ranks by actual failure type
    // instead of collapsing every distinct cause to the wrapper's name.
    class MiddlewareError extends Error {}
    class ProviderCrash extends Error {}
    const inner = new ProviderCrash("upstream blew up");
    const outer = new MiddlewareError("wrapModelCall failed");
    (outer as { cause?: unknown }).cause = inner;

    const described = describeErrorForTelemetry(outer);

    expect(described.errorClass).toBe("agent_error");
    expect(described.errorDetail).toBe("ProviderCrash");
  });

  test("prefers the deliberately-set .name over the wrapper's constructor", () => {
    // The core MiddlewareError case: the wrapper's constructor is the envelope
    // class, but its .name was set to the inner error's identity. Reading .name
    // recovers the real failure even with no cause link to walk.
    const wrapper = Object.assign(new Error("wrapModelCall failed"), {
      name: "AI_APICallError",
    });

    const described = describeErrorForTelemetry(wrapper);

    expect(described.errorClass).toBe("agent_error");
    expect(described.errorDetail).toBe("AI_APICallError");
  });

  test("a residual with an un-allowlisted name drops error_detail to undefined", () => {
    class Weird {}
    Object.defineProperty(Weird, "name", { value: "weird name/with space" });

    const described = describeErrorForTelemetry(new Weird());

    expect(described.errorClass).toBe("agent_error");
    expect(described.errorDetail).toBeUndefined();
  });

  test("http_status is surfaced from a wrapped provider error", () => {
    // firstStatusInChain reaches the status one cause deep even though the class
    // was recovered from the same link.
    const wrapped = new Error("tool failed");
    (wrapped as { cause?: unknown }).cause = { status: 503 };

    const described = describeErrorForTelemetry(wrapped);

    expect(described.errorClass).toBe("provider_error");
    expect(described.errorDetail).toBe("overloaded");
    expect(described.httpStatus).toBe(503);
  });

  test("firstStatusInChain returns undefined when no link exposes a status", () => {
    const wrapped = new Error("outer");
    (wrapped as { cause?: unknown }).cause = new Error("inner");

    expect(firstStatusInChain(wrapped)).toBeUndefined();
  });
});

describe("describeErrorForTelemetry - stream_open de-own", () => {
  /**
   * Tags `thrown` exactly as the production stream-open call site does — through
   * inStageSync with the { build_error, stream_open } origin — and returns the tagged
   * error, so these tests exercise the real tag, not a hand-built one.
   */
  function taggedStreamOpen(thrown: unknown): unknown {
    try {
      inStageSync(
        "build",
        () => {
          throw thrown;
        },
        {
          errorClass: "build_error",
          errorDetail: "stream_open",
        },
      );
    } catch (error) {
      return error;
    }
    throw new Error("expected the staged fn to throw");
  }

  test("a provider failure disguised as stream_open lands on the provider", () => {
    // A 503 thrown during the first provider round trip is the provider's fault, not
    // our stream-setup bug: the raw classification wins over the build_error tag.
    const described = describeErrorForTelemetry(
      taggedStreamOpen(Object.assign(new Error("upstream"), { status: 503 })),
    );

    expect(described).toMatchObject({
      errorClass: "provider_error",
      errorDetail: "overloaded",
      errorOwner: "provider",
      // The stage still records where it happened; only the class/owner move.
      errorStage: "build",
      httpStatus: 503,
    });
  });

  test("a genuine stream-setup failure keeps its build_error tag", () => {
    // No provider signal (no status, classifies as the residual): this really is our
    // stream-setup path, so the tag stands and the owner stays openwiki.
    const described = describeErrorForTelemetry(
      taggedStreamOpen(new Error("stream handshake failed")),
    );

    expect(described).toMatchObject({
      errorClass: "build_error",
      errorDetail: "stream_open",
      errorOwner: "openwiki",
      errorStage: "build",
    });
    expect(described.httpStatus).toBeUndefined();
  });

  test("an unclassifiable status does not regress build_error to the residual", () => {
    // A status is present but unmapped (418), so the raw classifier returns the
    // residual agent_error. De-owning here would trade an informative build_error for
    // the residual bucket, so the guard keeps the tag; the status still rides.
    const described = describeErrorForTelemetry(
      taggedStreamOpen(Object.assign(new Error("teapot"), { status: 418 })),
    );

    expect(described).toMatchObject({
      errorClass: "build_error",
      errorDetail: "stream_open",
      errorOwner: "openwiki",
      httpStatus: 418,
    });
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

  test("an owned-family tag survives re-wrapping and a later stage-only tag", async () => {
    // okf tags the inner failure with its owned class; a framework re-wraps it (the
    // tag is stranded on `.cause`) and the run bracket stamps the fresh wrapper with
    // a stage-only tag. The owned class must still win by walking the chain, instead
    // of decaying to agent_error the way a top-only read would.
    const inner = await inStage(
      "run",
      () => {
        throw new Error("index write failed");
      },
      { errorClass: "okf_error", errorDetail: "index_sync" },
    ).catch((error: unknown) => error);

    const outer = new Error("wrapModelCall failed");
    (outer as { cause?: unknown }).cause = inner;
    tagErrorStage(outer, "run");

    expect(describeErrorForTelemetry(outer)).toMatchObject({
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

  test("leaves stage and status undefined when absent, detail is the name", () => {
    // A bare residual Error carries no stage/status, but it is still fingerprinted:
    // "Error" is an allowlisted name, so the residual agent_error bucket carries it
    // as error_detail to slice on.
    expect(describeErrorForTelemetry(new Error("boom"))).toEqual({
      errorClass: "agent_error",
      errorDetail: "Error",
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

  test("returns false when captureImmediate rejects", async () => {
    posthog.captureImmediate.mockRejectedValue(new Error("network down"));

    await expect(
      captureEvent({
        distinctId: "id-rejected",
        event: "openwiki_run",
        properties: {},
      }),
    ).resolves.toBe(false);
    expect(posthog.shutdown).toHaveBeenCalledOnce();
  });

  test("returns false when captureImmediate times out", async () => {
    vi.useFakeTimers();
    posthog.captureImmediate.mockImplementation(
      () => new Promise<void>(() => {}),
    );

    const pending = captureEvent({
      distinctId: "id-timeout",
      event: "openwiki_run",
      properties: {},
    });
    const result = expect(pending).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(3000);

    await result;
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

  test("tees with owner-only permissions and leaves no scratch file behind", async () => {
    // The tee may land in a shared directory, so the write must not leak run
    // metadata to other local users and must clean up its atomic-write scratch.
    const dir = await mkdtemp(path.join(tmpdir(), "ow-tel-perms-"));
    const file = path.join(dir, "out.json");

    await recordRun(runDetails({ telemetryFile: file }));

    // The final payload is intact and it is the only file left in the directory
    // (the randomly-named scratch was renamed into place, not orphaned).
    expect((await readTee(file)).sent).toBe(true);
    expect(await readdir(dir)).toEqual(["out.json"]);

    // On POSIX the file is created 0o600 (owner read/write only). Windows does
    // not model these mode bits, so the assertion is POSIX-only.
    if (process.platform !== "win32") {
      const mode = (await stat(file)).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    await rm(dir, { force: true, recursive: true });
  });

  test("never throws even if capture fails", async () => {
    posthog.captureImmediate.mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(recordRun(runDetails())).resolves.toBeUndefined();
  });

  test("tees sent=false when an asynchronous capture is rejected", async () => {
    posthog.captureImmediate.mockRejectedValue(new Error("network down"));
    const file = path.join(tmpdir(), "ow-tel-rejected.json");

    await recordRun(runDetails({ telemetryFile: file }));

    await expect(readTee(file)).resolves.toMatchObject({
      disabled: false,
      sent: false,
    });
    await rm(file, { force: true });
  });

  test("tees sent=false when capture times out", async () => {
    vi.useFakeTimers();
    posthog.captureImmediate.mockImplementation(
      () => new Promise<void>(() => {}),
    );
    const file = path.join(tmpdir(), "ow-tel-timeout.json");

    const pending = recordRun(runDetails({ telemetryFile: file }));
    const completion = expect(pending).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(posthog.captureImmediate).toHaveBeenCalledOnce();
    });
    await vi.advanceTimersByTimeAsync(3000);
    await completion;

    await expect(readTee(file)).resolves.toMatchObject({
      disabled: false,
      sent: false,
    });
    await rm(file, { force: true });
  });

  test("reports, without throwing, when the tee file cannot be written", async () => {
    // A tee target under a regular file cannot have its parent directory
    // created; recordRun must log the failure and carry on, never breaking the
    // run over a diagnostics file.
    process.env.OPENWIKI_TELEMETRY_DISABLED = "1";
    const dir = await mkdtemp(path.join(tmpdir(), "ow-tel-badtee-"));
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    // `blocker` is a file, so mkdir of it as a parent directory fails.
    const file = path.join(blocker, "out.json");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordRun(runDetails({ telemetryFile: file })),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not write telemetry file"),
    );
    errorSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
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

  test("carries the error class onto a failed run's event", async () => {
    // A failure outcome attaches its classified error category so failures can
    // be split by kind without ever sending the raw message.
    await recordRun(
      runDetails({ outcome: "failure", errorClass: "provider_auth" }),
    );

    expect(runEvent().properties).toMatchObject({
      outcome: "failure",
      error_class: "provider_auth",
    });
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
    buildChannel: "official",
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
    // The residual fingerprint never rode as its own property; it is folded into
    // error_detail, so error_name must never appear on any event.
    expect(event.properties).not.toHaveProperty("error_name");
  });

  test("the residual fingerprint rides as error_detail", () => {
    // The residual bucket carries the innermost error's name as error_detail; it is
    // never emitted under a separate error_name property.
    const residual = buildRunEvent(
      {
        command: "init",
        outcome: "failure",
        errorClass: "agent_error",
        errorDetail: "TypeError",
        errorOwner: "unowned",
        errorStage: "run",
      },
      baseContext,
    );
    expect(residual.properties).toMatchObject({ error_detail: "TypeError" });
    expect(residual.properties).not.toHaveProperty("error_name");
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

  test("build_channel is stamped from the context on every event", () => {
    // The channel is a peer of production/ci: baked at build time, resolved by
    // the caller, and it rides both success and failure events verbatim.
    const official = buildRunEvent(
      { command: "init", outcome: "success" },
      { ...baseContext, buildChannel: "official" },
    );
    const community = buildRunEvent(
      { command: "update", outcome: "failure", errorClass: "agent_error" },
      { ...baseContext, buildChannel: "community" },
    );

    expect(official.properties.build_channel).toBe("official");
    expect(community.properties.build_channel).toBe("community");
  });
});

describe("buildChannel", () => {
  test("the committed default is community", () => {
    // The stamp script rewrites this to "official" only on the official release
    // path; the committed source must always resolve to "community" so a fork or
    // local build never mislabels its telemetry as official.
    expect(buildChannel()).toBe("community");
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
    buildChannel: "official",
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
          // A fixed-family detail is an allowlisted word; the residual agent_error
          // bucket instead carries the innermost error's name, gated to a bare
          // identifier. Either shape is inside the envelope; nothing else is.
          expect(
            DETAIL_ALLOWLIST.has(value as string) ||
              isSafeErrorIdentifier(value),
          ).toBe(true);
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
        case "build_channel":
          // A closed two-value enum baked at build time; never a free string.
          expect(["official", "community"]).toContain(value);
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
