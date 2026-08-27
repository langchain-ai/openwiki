import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ConnectorId,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../../src/connectors/types.ts";
import type {
  OnboardingSourceInstanceConfig,
  OpenWikiOnboardingConfig,
} from "../../src/setup/onboarding.ts";
import type { OpenWikiRunEvent } from "../../src/agent/types.ts";

// This file exercises the runOpenWikiIngestion orchestrator and the private
// message/policy/per-source helpers. Every heavy collaborator (env load, home
// creation, onboarding read, connector registry, and the agent run) is mocked
// so no real LLM, network, git, or filesystem work happens. The pure-surface
// tests live in ingestion.test.ts; keeping the mocks in a separate file avoids
// disturbing that file's real createConnectorRegistry usage.

vi.mock("../../src/config/env.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../src/config/env.ts")>();
  return { ...actual, loadOpenWikiEnv: vi.fn().mockResolvedValue({}) };
});

vi.mock("../../src/config/openwiki-home.ts", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/config/openwiki-home.ts")>();
  // Keep the pure path helpers real (getConnectorConfigPath / openWikiLocalWikiDir
  // are asserted downstream) but neuter the mkdir side effect on the real home.
  return {
    ...actual,
    ensureOpenWikiHome: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/setup/onboarding.ts", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/setup/onboarding.ts")>();
  return { ...actual, readOpenWikiOnboardingConfig: vi.fn() };
});

vi.mock("../../src/connectors/registry.ts", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/connectors/registry.ts")>();
  // isConnectorId stays real (it is the connected-source gate); only the
  // registry factory is swapped so a fake, side-effect-free connector is used.
  return { ...actual, createConnectorRegistry: vi.fn() };
});

vi.mock("../../src/agent/index.ts", () => ({
  createOpenWikiThreadId: vi.fn(() => "thread-test"),
  runOpenWikiAgent: vi.fn(),
}));

vi.mock("../../src/telemetry/index.ts", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/telemetry/index.ts")>();
  return {
    ...actual,
    withRunTelemetry: vi.fn(
      (
        _command: unknown,
        _options: unknown,
        _context: unknown,
        run: () => Promise<unknown>,
      ) => run(),
    ),
  };
});

import { readOpenWikiOnboardingConfig } from "../../src/setup/onboarding.ts";
import { createConnectorRegistry } from "../../src/connectors/registry.ts";
import { getConnectorConfigPath } from "../../src/config/openwiki-home.ts";
import { runOpenWikiAgent } from "../../src/agent/index.ts";
import { runOpenWikiIngestion } from "../../src/ingestion/ingestion.ts";

/** Build a fake connector whose ingest is fully controllable. */
function makeConnector(
  id: ConnectorId,
  overrides: Partial<ConnectorRuntime> = {},
): ConnectorRuntime {
  return {
    backend: "direct-api",
    description: `${id} test connector`,
    displayName: id,
    id,
    mode: "personal",
    requiredEnv: [],
    // false => deterministic path (ingest is called before the agent run).
    supportsAgenticDiscovery: false,
    ingest: vi.fn(),
    ...overrides,
  };
}

/** A deterministic pull result the connector.ingest mock can resolve with. */
function makeIngestResult(
  id: ConnectorId,
  overrides: Partial<ConnectorIngestResult> = {},
): ConnectorIngestResult {
  return {
    connectorId: id,
    message: `${id} pulled`,
    rawFiles: [`/home/.openwiki/connectors/${id}/raw/a.json`],
    runId: "run-1",
    statePath: `/home/.openwiki/connectors/${id}/state.json`,
    status: "success",
    warnings: [],
    ...overrides,
  };
}

/** A source instance that passes the connected + known-connector gate. */
function makeSourceInstance(
  overrides: Partial<OnboardingSourceInstanceConfig> & {
    connectorId: ConnectorId;
    id: string;
  },
): OnboardingSourceInstanceConfig {
  return {
    connectedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** An onboarding config carrying the given source instances. */
function makeConfig(
  sourceInstances: OnboardingSourceInstanceConfig[],
  overrides: Partial<OpenWikiOnboardingConfig> = {},
): OpenWikiOnboardingConfig {
  return {
    sourceInstances,
    sources: {},
    version: 1,
    wikiGoal: "Track project status.",
    ...overrides,
  };
}

/** Register the config + registry the orchestrator will read this run. */
function primeRun(
  config: OpenWikiOnboardingConfig,
  registry: Partial<Record<ConnectorId, ConnectorRuntime>>,
): void {
  vi.mocked(readOpenWikiOnboardingConfig).mockResolvedValue(config);
  vi.mocked(createConnectorRegistry).mockReturnValue(
    registry as Record<ConnectorId, ConnectorRuntime>,
  );
}

/** Collect the text of every emitted progress event. */
function textEvents(events: OpenWikiRunEvent[]): string {
  return events
    .filter((event) => event.type === "text")
    .map((event) => (event as { text: string }).text)
    .join("");
}

beforeEach(() => {
  vi.mocked(runOpenWikiAgent).mockResolvedValue(
    {} as Awaited<ReturnType<typeof runOpenWikiAgent>>,
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runOpenWikiIngestion", () => {
  test("runs a single deterministic source and composes the pull-aware message", async () => {
    // A deterministic connector is pulled first, and the composed agent message
    // must carry the pull result, the raw file paths, and the synthesis policy
    // so the model updates the wiki from the freshly written evidence.
    const connector = makeConnector("git-repo");
    const pull = makeIngestResult("git-repo", {
      rawFiles: ["/raw/one.json", "/raw/two.json"],
    });
    vi.mocked(connector.ingest).mockResolvedValue(pull);

    const source = makeSourceInstance({
      connectorId: "git-repo",
      id: "git-repo",
      ingestionGoal: "Watch the release branch.",
    });
    primeRun(makeConfig([source]), { "git-repo": connector });

    const events: OpenWikiRunEvent[] = [];
    const result = await runOpenWikiIngestion("/some/cwd", {
      target: "git-repo",
      onEvent: (event) => events.push(event),
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe("agent-updated");
    expect(result.results[0]?.rawFiles).toEqual(pull.rawFiles);

    // The connector pull ran with the ingestion window and instance id.
    expect(connector.ingest).toHaveBeenCalledWith({
      connectorConfig: undefined,
      instanceId: "git-repo",
      windowHours: 24,
    });

    // The agent ran once against the local wiki dir with the composed message.
    expect(runOpenWikiAgent).toHaveBeenCalledTimes(1);
    const [phase, , runOptions] = vi.mocked(runOpenWikiAgent).mock.calls[0];
    expect(phase).toBe("update");
    const message = runOptions.userMessage ?? "";
    expect(message).toContain("Deterministic pull result:");
    expect(message).toContain("Status: success");
    expect(message).toContain("- /raw/one.json");
    expect(message).toContain("- /raw/two.json");
    expect(message).toContain("Watch the release branch.");
    expect(message).toContain("Track project status.");
    // The synthesis policy is inlined into the message.
    expect(message).toContain("Reusable synthesis policy:");
    expect(message).toContain("Apply confidence labels");

    // Progress is surfaced: a start line plus the deterministic pull summary.
    const emitted = textEvents(events);
    expect(emitted).toContain("Starting git-repo ingestion.");
    expect(emitted).toContain("git-repo pulled");
  });

  test("composes the discovery message (no pull) for an agentic connector", async () => {
    // An agentic connector is not pulled up front, so the message must instead
    // point the agent at connector tools and the connector config path.
    const connector = makeConnector("web-search", {
      supportsAgenticDiscovery: true,
    });

    const source = makeSourceInstance({
      connectorId: "web-search",
      id: "web-search",
    });
    primeRun(makeConfig([source]), { "web-search": connector });

    const result = await runOpenWikiIngestion(undefined, {
      target: "web-search",
    });

    // Agentic connectors skip the deterministic ingest entirely.
    expect(connector.ingest).not.toHaveBeenCalled();
    expect(result.results[0]?.status).toBe("agent-updated");

    const runOptions = vi.mocked(runOpenWikiAgent).mock.calls[0][2];
    const message = runOptions.userMessage ?? "";
    expect(message).toContain("cannot be fully pulled deterministically");
    expect(message).toContain(
      `Connector config path: ${getConnectorConfigPath("web-search")}`,
    );
    expect(message).not.toContain("Deterministic pull result:");
  });

  test("includes the source instance name when one is configured", async () => {
    // A named instance disambiguates multiple instances of one connector, so
    // the display name and the parenthetical id/name must reach the message.
    const connector = makeConnector("git-repo");
    vi.mocked(connector.ingest).mockResolvedValue(makeIngestResult("git-repo"));

    const source = makeSourceInstance({
      connectorId: "git-repo",
      id: "repo-primary",
      name: "Primary repo",
    });
    primeRun(makeConfig([source]), { "git-repo": connector });

    await runOpenWikiIngestion(undefined, {
      target: { kind: "source-instance", id: "repo-primary" },
    });

    const message =
      vi.mocked(runOpenWikiAgent).mock.calls[0][2].userMessage ?? "";
    expect(message).toContain("Primary repo");
    expect(message).toContain("repo-primary (Primary repo)");
  });

  test("marks a zero-item pull as updated with an explicit no-files note", async () => {
    // A successful pull that wrote nothing still runs the agent, and the
    // message must state there are no raw files rather than omit the section.
    const connector = makeConnector("git-repo");
    vi.mocked(connector.ingest).mockResolvedValue(
      makeIngestResult("git-repo", { rawFiles: [], message: "nothing new" }),
    );

    const source = makeSourceInstance({
      connectorId: "git-repo",
      id: "git-repo",
    });
    primeRun(makeConfig([source]), { "git-repo": connector });

    const events: OpenWikiRunEvent[] = [];
    const result = await runOpenWikiIngestion(undefined, {
      target: "git-repo",
      onEvent: (event) => events.push(event),
    });

    expect(result.results[0]?.status).toBe("agent-updated");
    expect(runOpenWikiAgent).toHaveBeenCalledTimes(1);
    const message =
      vi.mocked(runOpenWikiAgent).mock.calls[0][2].userMessage ?? "";
    expect(message).toContain("(no raw files written)");
    expect(textEvents(events)).toContain("Raw files: none");
  });

  test("short-circuits on a deterministic pull error without running the agent", async () => {
    // A hard pull failure with no salvaged files is terminal for that source:
    // it must be reported as an error and must not reach the agent.
    const connector = makeConnector("git-repo");
    vi.mocked(connector.ingest).mockResolvedValue(
      makeIngestResult("git-repo", {
        rawFiles: [],
        status: "error",
        message: "auth expired",
      }),
    );

    const source = makeSourceInstance({
      connectorId: "git-repo",
      id: "git-repo",
    });
    primeRun(makeConfig([source]), { "git-repo": connector });

    const events: OpenWikiRunEvent[] = [];
    const result = await runOpenWikiIngestion(undefined, {
      target: "git-repo",
      onEvent: (event) => events.push(event),
    });

    expect(result.results[0]?.status).toBe("error");
    expect(result.results[0]?.deterministicPull?.message).toBe("auth expired");
    expect(runOpenWikiAgent).not.toHaveBeenCalled();
    expect(textEvents(events)).toContain(
      "deterministic pull failed: auth expired",
    );
  });

  test("isolates a thrown connector ingest into a single error result", async () => {
    // A connector that throws mid-pull must be caught and reported as an error
    // for that source only, again without invoking the agent.
    const connector = makeConnector("git-repo");
    vi.mocked(connector.ingest).mockRejectedValue(new Error("boom"));

    const source = makeSourceInstance({
      connectorId: "git-repo",
      id: "git-repo",
    });
    primeRun(makeConfig([source]), { "git-repo": connector });

    const events: OpenWikiRunEvent[] = [];
    const result = await runOpenWikiIngestion(undefined, {
      target: "git-repo",
      onEvent: (event) => events.push(event),
    });

    expect(result.results[0]?.status).toBe("error");
    expect(result.results[0]?.rawFiles).toEqual([]);
    expect(runOpenWikiAgent).not.toHaveBeenCalled();
    expect(textEvents(events)).toContain("ingestion failed: boom");
  });

  test("fans out across every connected source for the all target", async () => {
    // The "all" target ingests each connected source in turn, and one source
    // failing must not stop or corrupt the others (per-source isolation).
    const good = makeConnector("git-repo");
    vi.mocked(good.ingest).mockResolvedValue(makeIngestResult("git-repo"));
    const bad = makeConnector("hackernews");
    vi.mocked(bad.ingest).mockRejectedValue(new Error("network down"));

    const config = makeConfig([
      makeSourceInstance({ connectorId: "git-repo", id: "git-repo" }),
      makeSourceInstance({ connectorId: "hackernews", id: "hackernews" }),
    ]);
    primeRun(config, { "git-repo": good, hackernews: bad });

    const result = await runOpenWikiIngestion(undefined, { target: "all" });

    expect(result.results).toHaveLength(2);
    const byId = Object.fromEntries(
      result.results.map((entry) => [entry.connectorId, entry.status]),
    );
    expect(byId["git-repo"]).toBe("agent-updated");
    expect(byId.hackernews).toBe("error");
    // Only the healthy source reached the agent.
    expect(runOpenWikiAgent).toHaveBeenCalledTimes(1);
  });

  test("throws when a specific target matches no connected source", async () => {
    // For a non-"all" target, an empty match set is a user error and must be
    // reported rather than silently producing zero results.
    primeRun(makeConfig([]), {});

    await expect(
      runOpenWikiIngestion(undefined, { target: "git-repo" }),
    ).rejects.toThrow("No configured ingestion source matched git-repo");
    expect(runOpenWikiAgent).not.toHaveBeenCalled();
  });

  test("names the source-instance id when that target matches nothing", async () => {
    // The no-match error must format a source-instance target by its id, not by
    // leaking the wrapper object into the message.
    primeRun(makeConfig([]), {});

    await expect(
      runOpenWikiIngestion(undefined, {
        target: { kind: "source-instance", id: "repo-missing" },
      }),
    ).rejects.toThrow("No configured ingestion source matched repo-missing");
  });

  test("falls back to not-provided when goals are absent", async () => {
    // A source with neither a wiki goal nor an ingestion goal must still yield a
    // valid message, with explicit not-provided placeholders on both fields.
    // Cover both message templates: an agentic source (named, no goals) and a
    // deterministic source (no goals) both fall back to the placeholders.
    const agentic = makeConnector("web-search", {
      supportsAgenticDiscovery: true,
    });
    primeRun(
      makeConfig(
        [
          makeSourceInstance({
            connectorId: "web-search",
            id: "web-search",
            name: "Web",
          }),
        ],
        { wikiGoal: undefined },
      ),
      { "web-search": agentic },
    );

    await runOpenWikiIngestion(undefined, { target: "web-search" });
    const agenticMessage =
      vi.mocked(runOpenWikiAgent).mock.calls[0][2].userMessage ?? "";
    expect(agenticMessage).toContain("web-search (Web)");
    expect(agenticMessage).toContain("User wiki goal:\n(not provided)");
    expect(agenticMessage).toContain(
      "Source-specific instructions:\n(not provided)",
    );

    vi.clearAllMocks();
    vi.mocked(runOpenWikiAgent).mockResolvedValue(
      {} as Awaited<ReturnType<typeof runOpenWikiAgent>>,
    );
    const deterministic = makeConnector("git-repo");
    vi.mocked(deterministic.ingest).mockResolvedValue(
      makeIngestResult("git-repo"),
    );
    primeRun(
      makeConfig(
        [makeSourceInstance({ connectorId: "git-repo", id: "git-repo" })],
        { wikiGoal: undefined },
      ),
      { "git-repo": deterministic },
    );

    await runOpenWikiIngestion(undefined, { target: "git-repo" });
    const deterministicMessage =
      vi.mocked(runOpenWikiAgent).mock.calls[0][2].userMessage ?? "";
    expect(deterministicMessage).toContain("User wiki goal:\n(not provided)");
  });

  test("stringifies a non-Error thrown by a connector", async () => {
    // Connectors may reject with a non-Error value; the error result must carry
    // a stringified message rather than crashing the per-source catch.
    const connector = makeConnector("git-repo");
    vi.mocked(connector.ingest).mockRejectedValue("plain string failure");
    primeRun(
      makeConfig([
        makeSourceInstance({ connectorId: "git-repo", id: "git-repo" }),
      ]),
      { "git-repo": connector },
    );

    const events: OpenWikiRunEvent[] = [];
    const result = await runOpenWikiIngestion(undefined, {
      target: "git-repo",
      onEvent: (event) => events.push(event),
    });

    expect(result.results[0]?.status).toBe("error");
    expect(textEvents(events)).toContain(
      "ingestion failed: plain string failure",
    );
  });

  test("returns no results for the all target when nothing is connected", async () => {
    // "all" with nothing connected is a valid no-op, not an error.
    primeRun(makeConfig([]), {});

    const result = await runOpenWikiIngestion(undefined, { target: "all" });
    expect(result.results).toEqual([]);
    expect(runOpenWikiAgent).not.toHaveBeenCalled();
  });

  test("scheduledOnly skips sources when the schedule is missing or paused", async () => {
    // scheduledOnly gates the run on an active schedule; a paused or absent
    // schedule filters every source out, so a specific target finds no match.
    const connector = makeConnector("git-repo");
    vi.mocked(connector.ingest).mockResolvedValue(makeIngestResult("git-repo"));
    const source = makeSourceInstance({
      connectorId: "git-repo",
      id: "git-repo",
    });

    // Paused schedule => filtered out.
    primeRun(
      makeConfig([source], {
        ingestionSchedule: {
          description: "daily",
          expression: "0 9 * * *",
          updatedAt: "2026-07-01T00:00:00.000Z",
          pausedAt: "2026-07-02T00:00:00.000Z",
        },
      }),
      { "git-repo": connector },
    );

    await expect(
      runOpenWikiIngestion(undefined, {
        target: "git-repo",
        scheduledOnly: true,
      }),
    ).rejects.toThrow("No configured ingestion source matched");
  });

  test("scheduledOnly runs sources when an active schedule exists", async () => {
    // With an active (non-paused) schedule the scheduled run proceeds normally.
    const connector = makeConnector("git-repo");
    vi.mocked(connector.ingest).mockResolvedValue(makeIngestResult("git-repo"));
    const source = makeSourceInstance({
      connectorId: "git-repo",
      id: "git-repo",
    });

    primeRun(
      makeConfig([source], {
        ingestionSchedule: {
          description: "daily",
          expression: "0 9 * * *",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      }),
      { "git-repo": connector },
    );

    const result = await runOpenWikiIngestion(undefined, {
      target: "all",
      scheduledOnly: true,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe("agent-updated");
  });

  test("skips sources that were never connected", async () => {
    // A source instance without connectedAt is not eligible, so an "all" run
    // over only-unconnected sources yields nothing and never calls the agent.
    const connector = makeConnector("git-repo");
    const source: OnboardingSourceInstanceConfig = {
      connectorId: "git-repo",
      id: "git-repo",
    };
    primeRun(makeConfig([source]), { "git-repo": connector });

    const result = await runOpenWikiIngestion(undefined, { target: "all" });
    expect(result.results).toEqual([]);
    expect(connector.ingest).not.toHaveBeenCalled();
  });
});
