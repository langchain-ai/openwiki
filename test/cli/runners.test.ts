import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";

// The heavy IO dependencies are mocked so the runners can be exercised without
// spawning tunnels, servers, agents, or touching the schedule/onboarding config
// on disk. The diagnostics, formatting, run-mode, and config modules are left
// REAL so the asserted stdout/stderr text is the genuine output.
vi.mock("../../src/auth/configure.ts", () => ({
  configureAuthProvider: vi.fn(),
  listAuthProviderTools: vi.fn(),
  shouldDiscoverToolsAfterAuth: vi.fn(() => false),
}));
vi.mock("../../src/auth/ngrok.ts", () => ({
  startNgrokTunnel: vi.fn(),
}));
vi.mock("../../src/auth/oauth.ts", () => ({
  formatAuthProviderList: vi.fn(() => "provider-list"),
  runOAuthAuth: vi.fn(),
}));
vi.mock("../../src/agent/index.ts", () => ({
  createOpenWikiThreadId: vi.fn(() => "thread-1"),
  runOpenWikiAgent: vi.fn(),
}));
vi.mock("../../src/ingestion/code-mode.ts", () => ({
  ensureCodeModeRepoSetup: vi.fn(),
  runCodeModeConnectors: vi.fn(),
}));
vi.mock("../../src/ingestion/ingestion.ts", () => ({
  runOpenWikiIngestion: vi.fn(),
}));
vi.mock("../../src/scheduling/schedules.ts", () => ({
  deleteConnectorSchedules: vi.fn(),
  getSavedPowerScheduleStatus: vi.fn(() => null),
  listConnectorSchedules: vi.fn(() => []),
  pauseConnectorSchedules: vi.fn(),
  resumeConnectorSchedules: vi.fn(),
}));
vi.mock("../../src/setup/onboarding.ts", () => ({
  readOpenWikiOnboardingConfig: vi.fn(() => ({})),
  saveOpenWikiOnboardingConfig: vi.fn(),
}));
vi.mock("../../src/telemetry/index.ts", () => ({
  withRunTelemetry: vi.fn(
    async (
      _command: unknown,
      _options: unknown,
      _context: unknown,
      run: () => Promise<unknown>,
    ) => run(),
  ),
}));
vi.mock("../../src/visualize/server.ts", () => ({
  runVisualizeServer: vi.fn(),
}));

import {
  configureAuthProvider,
  listAuthProviderTools,
  shouldDiscoverToolsAfterAuth,
} from "../../src/auth/configure.ts";
import { startNgrokTunnel } from "../../src/auth/ngrok.ts";
import { runOAuthAuth } from "../../src/auth/oauth.ts";
import { runOpenWikiAgent } from "../../src/agent/index.ts";
import {
  ensureCodeModeRepoSetup,
  runCodeModeConnectors,
} from "../../src/ingestion/code-mode.ts";
import { runOpenWikiIngestion } from "../../src/ingestion/ingestion.ts";
import {
  deleteConnectorSchedules,
  listConnectorSchedules,
  pauseConnectorSchedules,
  resumeConnectorSchedules,
} from "../../src/scheduling/schedules.ts";
import { saveOpenWikiOnboardingConfig } from "../../src/setup/onboarding.ts";
import { runVisualizeServer } from "../../src/visualize/server.ts";
import type { CliCommand } from "../../src/cli/commands.ts";
import {
  runAuthCommand,
  runCronCommand,
  runIngestCommand,
  runNgrokCommand,
  runPrintCommand,
  runVisualizeCommand,
  writePrintAuthFix,
  writePrintErrorDiagnostics,
} from "../../src/cli/runners.ts";

/**
 * A fake Anthropic key. It is planted in both `process.env` (so the diagnostic
 * sanitizer knows to redact it) and inside an error message, to prove the raw
 * value never reaches stderr.
 */
const FAKE_SECRET = "sk-ant-FAKE-secret-value-000111222";

let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let stdout: string[];
let stderr: string[];
let savedExitCode: typeof process.exitCode;

const savedEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  stdout = [];
  stderr = [];
  savedExitCode = process.exitCode;
  stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  process.exitCode = savedExitCode;
  // Restore any env keys the tests set (provider selection, planted secret).
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

/**
 * Builds a `CliCommand` of the requested kind from a partial. The runners read
 * only a handful of fields, so the cast keeps the fixtures terse.
 */
function makeCommand<K extends CliCommand["kind"]>(
  kind: K,
  fields: Record<string, unknown>,
): Extract<CliCommand, { kind: K }> {
  return { kind, exitCode: 0, ...fields } as unknown as Extract<
    CliCommand,
    { kind: K }
  >;
}

describe("runNgrokCommand", () => {
  test("starts the tunnel and exits 0 on success", async () => {
    vi.mocked(startNgrokTunnel).mockResolvedValue(undefined as never);

    await runNgrokCommand(makeCommand("ngrok", { port: 4040, url: null }));

    expect(startNgrokTunnel).toHaveBeenCalledWith({ port: 4040, url: null });
    expect(process.exitCode).toBe(0);
    expect(stderr.join("")).toBe("");
  });

  test("reports the error and exits 1 on failure", async () => {
    vi.mocked(startNgrokTunnel).mockRejectedValue(new Error("tunnel down"));

    await runNgrokCommand(makeCommand("ngrok", { port: 4040, url: null }));

    expect(stderr.join("")).toContain("tunnel down");
    expect(process.exitCode).toBe(1);
  });
});

describe("runVisualizeCommand", () => {
  test("resolves the wiki root and starts the server", async () => {
    vi.mocked(runVisualizeServer).mockResolvedValue(undefined);

    await runVisualizeCommand(
      makeCommand("visualize", { wikiDir: "wiki", port: 8080, open: true }),
    );

    const call = vi.mocked(runVisualizeServer).mock.calls[0][0];
    expect(call.port).toBe(8080);
    expect(call.open).toBe(true);
    // The relative wikiDir is resolved against cwd to an absolute path.
    expect(call.wikiRoot).toMatch(/wiki$/u);
    expect(call.wikiRoot.startsWith("/")).toBe(true);
    expect(process.exitCode).not.toBe(1);
  });

  test("reports the error and exits 1 when the server throws", async () => {
    vi.mocked(runVisualizeServer).mockRejectedValue(new Error("no wiki dir"));

    await runVisualizeCommand(
      makeCommand("visualize", { wikiDir: "wiki", port: 8080, open: false }),
    );

    expect(stderr.join("")).toContain("no wiki dir");
    expect(process.exitCode).toBe(1);
  });
});

describe("runCronCommand", () => {
  test("lists schedules and reports when none are configured", async () => {
    await runCronCommand(makeCommand("cron", { action: "list", target: null }));

    const output = stdout.join("");
    expect(output).toContain("OpenWiki Schedules");
    expect(output).toContain("No connector schedules are configured.");
    expect(process.exitCode).toBe(0);
  });

  test("dispatches a pause mutation, persists the config, and reprints", async () => {
    const nextConfig = { connectors: {} };
    vi.mocked(pauseConnectorSchedules).mockResolvedValue({
      config: nextConfig,
      connectorIds: ["hackernews"],
      skippedConnectorIds: [],
      warnings: [],
    } as never);

    await runCronCommand(
      makeCommand("cron", { action: "pause", target: "hackernews" }),
    );

    expect(pauseConnectorSchedules).toHaveBeenCalledWith(
      expect.anything(),
      "hackernews",
    );
    // The mutated config is saved and the listing is reprinted afterward.
    expect(saveOpenWikiOnboardingConfig).toHaveBeenCalledWith(nextConfig);
    expect(listConnectorSchedules).toHaveBeenCalled();
    const output = stdout.join("");
    expect(output).toContain("Paused");
    expect(output).toContain("hackernews");
    expect(process.exitCode).toBe(0);
  });

  test("routes resume and delete actions to their own helpers", async () => {
    vi.mocked(resumeConnectorSchedules).mockResolvedValue({
      config: {},
      connectorIds: [],
      skippedConnectorIds: [],
      warnings: [],
    } as never);
    vi.mocked(deleteConnectorSchedules).mockResolvedValue({
      config: {},
      connectorIds: [],
      skippedConnectorIds: [],
      warnings: [],
    } as never);

    await runCronCommand(
      makeCommand("cron", { action: "resume", target: "all" }),
    );
    const resumeArg = vi.mocked(resumeConnectorSchedules).mock.calls[0][0];
    expect(resumeArg.target).toBe("all");
    expect(typeof resumeArg.cwd).toBe("string");
    expect(resumeArg.config).toBeDefined();

    await runCronCommand(
      makeCommand("cron", { action: "delete", target: "all" }),
    );
    expect(deleteConnectorSchedules).toHaveBeenCalledWith(
      expect.anything(),
      "all",
    );
  });

  test("errors and exits 1 when a mutation has no target", async () => {
    await runCronCommand(
      makeCommand("cron", { action: "pause", target: null }),
    );

    expect(stderr.join("")).toContain("Target is required for cron pause.");
    expect(pauseConnectorSchedules).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("runIngestCommand", () => {
  test("streams text events, prints a summary, and exits 0", async () => {
    vi.mocked(runOpenWikiIngestion).mockImplementation(
      (_cwd: string, options: { onEvent?: (event: unknown) => void }) => {
        options.onEvent?.({ type: "text", source: "agent", text: "hi" });
        return Promise.resolve({
          results: [
            { displayName: "HackerNews", status: "success", rawFiles: ["a"] },
          ],
        } as never);
      },
    );

    await runIngestCommand(
      makeCommand("ingest", {
        modelId: null,
        print: false,
        scheduledOnly: false,
        target: "all",
      }),
    );

    const output = stdout.join("");
    expect(output).toContain("hi");
    expect(output).toContain("Ingestion summary");
    expect(output).toContain("HackerNews: success; 1 raw file(s)");
    expect(process.exitCode).toBe(0);
  });

  test("exits 1 when any source errored", async () => {
    vi.mocked(runOpenWikiIngestion).mockResolvedValue({
      results: [{ displayName: "Slack", status: "error", rawFiles: [] }],
    } as never);

    await runIngestCommand(
      makeCommand("ingest", {
        modelId: null,
        print: false,
        scheduledOnly: false,
        target: "all",
      }),
    );

    expect(stdout.join("")).toContain("Slack: error; 0 raw file(s)");
    expect(process.exitCode).toBe(1);
  });

  test("reports a thrown error and exits 1", async () => {
    vi.mocked(runOpenWikiIngestion).mockRejectedValue(new Error("boom"));

    await runIngestCommand(
      makeCommand("ingest", {
        modelId: null,
        print: false,
        scheduledOnly: false,
        target: "all",
      }),
    );

    expect(stderr.join("")).toContain("boom");
    expect(process.exitCode).toBe(1);
  });
});

describe("runAuthCommand", () => {
  test("lists providers", async () => {
    await runAuthCommand(
      makeCommand("auth", { action: "list", force: false, provider: null }),
    );

    expect(stdout.join("")).toContain("provider-list");
    expect(process.exitCode).toBe(0);
  });

  test("configures a provider and prints its next steps", async () => {
    vi.mocked(configureAuthProvider).mockResolvedValue({
      status: "created",
      configPath: "/home/.openwiki/auth.json",
      nextSteps: ["Restart the agent"],
    } as never);

    await runAuthCommand(
      makeCommand("auth", {
        action: "configure",
        force: false,
        provider: "anthropic",
      }),
    );

    const output = stdout.join("");
    expect(output).toContain("Config created: /home/.openwiki/auth.json");
    expect(output).toContain("- Restart the agent");
    expect(process.exitCode).toBe(0);
  });

  test("throws and exits 1 when a provider is required but missing", async () => {
    await runAuthCommand(
      makeCommand("auth", {
        action: "configure",
        force: false,
        provider: null,
      }),
    );

    expect(stderr.join("")).toContain("Auth provider is required.");
    expect(configureAuthProvider).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("runs oauth and prints only saved env-key NAMES, never secrets", async () => {
    vi.mocked(runOAuthAuth).mockResolvedValue({
      provider: "anthropic",
      savedEnvKeys: ["ANTHROPIC_API_KEY"],
    } as never);
    vi.mocked(configureAuthProvider).mockResolvedValue({
      status: "exists",
      configPath: "/home/.openwiki/auth.json",
      nextSteps: [],
    } as never);

    await runAuthCommand(
      makeCommand("auth", {
        action: "oauth",
        force: false,
        provider: "anthropic",
      }),
    );

    const output = stdout.join("");
    // The env-key NAME is surfaced so the user knows what was written...
    expect(output).toContain("Saved anthropic auth values: ANTHROPIC_API_KEY");
    expect(output).toContain("Config already exists");
    // ...but no secret value is ever printed.
    expect(output).not.toContain(FAKE_SECRET);
    expect(process.exitCode).toBe(0);
  });

  test("discovers tools after oauth when the provider supports it", async () => {
    vi.mocked(runOAuthAuth).mockResolvedValue({
      provider: "slack",
      savedEnvKeys: ["SLACK_TOKEN"],
    } as never);
    vi.mocked(configureAuthProvider).mockResolvedValue({
      status: "created",
      configPath: "/c",
      nextSteps: [],
    } as never);
    vi.mocked(shouldDiscoverToolsAfterAuth).mockReturnValue(true);
    vi.mocked(listAuthProviderTools).mockResolvedValue({
      provider: "slack",
      configPath: "/c",
      rawFile: "/raw.json",
      tools: [{ name: "post_message" }],
    } as never);

    await runAuthCommand(
      makeCommand("auth", {
        action: "oauth",
        force: false,
        provider: "slack",
      }),
    );

    const output = stdout.join("");
    expect(output).toContain("Discovered 1 MCP tool(s); wrote /raw.json");
    expect(output).toContain("Tools: post_message");
    expect(process.exitCode).toBe(0);
  });

  test("skips tool discovery gracefully when it throws", async () => {
    vi.mocked(runOAuthAuth).mockResolvedValue({
      provider: "slack",
      savedEnvKeys: [],
    } as never);
    vi.mocked(configureAuthProvider).mockResolvedValue({
      status: "created",
      configPath: "/c",
      nextSteps: [],
    } as never);
    vi.mocked(shouldDiscoverToolsAfterAuth).mockReturnValue(true);
    vi.mocked(listAuthProviderTools).mockRejectedValue(
      new Error("discovery failed"),
    );

    await runAuthCommand(
      makeCommand("auth", {
        action: "oauth",
        force: false,
        provider: "slack",
      }),
    );

    // The failure is a soft skip, not a hard error: the command still exits 0.
    expect(stdout.join("")).toContain(
      "MCP tool discovery skipped: discovery failed",
    );
    expect(process.exitCode).toBe(0);
  });
});

describe("runPrintCommand", () => {
  test("prints native repository lifecycle progress without tool transcripts", async () => {
    vi.mocked(runOpenWikiAgent).mockImplementation(
      (
        _command: unknown,
        _cwd: unknown,
        options: { onEvent?: (event: unknown) => void },
      ) => {
        options.onEvent?.({
          type: "repository_progress",
          stage: "planning",
          resumed: false,
        });
        options.onEvent?.({
          type: "tool_start",
          call: "read_file(/README.md)",
          id: "read-1",
          input: { path: "/README.md" },
          name: "read_file",
        });
        options.onEvent?.({
          type: "repository_progress",
          stage: "generating",
          page: "/openwiki/quickstart.md",
          pageIndex: 1,
          pageCount: 1,
        });
        options.onEvent?.({
          type: "repository_progress",
          stage: "finalizing",
        });
        return Promise.resolve(undefined as never);
      },
    );

    await runPrintCommand(
      makeCommand("run", {
        command: "init",
        dryRun: false,
        language: null,
        mode: "code",
        modeSource: "option",
        modelId: null,
        print: true,
        shouldStart: true,
        userMessage: null,
        telemetryFile: null,
      }),
    );

    const output = stdout.join("");
    expect(output).toContain("Planning repository wiki");
    expect(output).toContain(
      "Documenting page 1 of 1 · /openwiki/quickstart.md",
    );
    expect(output).toContain("Finalizing repository wiki");
    expect(output).not.toContain("read_file");
    expect(output).not.toContain("tool_start");
  });

  test("runs the agent, prints collected text, and exits 0", async () => {
    vi.mocked(runOpenWikiAgent).mockImplementation(
      (
        _command: unknown,
        _cwd: unknown,
        options: { onEvent?: (event: unknown) => void },
      ) => {
        options.onEvent?.({ type: "text", source: "agent", text: "wiki done" });
        return Promise.resolve(undefined as never);
      },
    );

    await runPrintCommand(
      makeCommand("run", {
        command: "update",
        dryRun: false,
        language: null,
        mode: "personal",
        modeSource: "default",
        modelId: null,
        print: true,
        shouldStart: false,
        userMessage: null,
        telemetryFile: null,
      }),
    );

    expect(stdout.join("")).toContain("wiki done");
    expect(process.exitCode).toBe(0);
  });

  test("pulls code-mode connectors before the agent in code mode", async () => {
    vi.mocked(runCodeModeConnectors).mockResolvedValue("augmented");
    vi.mocked(runOpenWikiAgent).mockResolvedValue(undefined as never);

    await runPrintCommand(
      makeCommand("run", {
        command: "init",
        dryRun: false,
        language: null,
        mode: "code",
        modeSource: "option",
        modelId: null,
        print: true,
        shouldStart: true,
        userMessage: null,
        telemetryFile: null,
      }),
    );

    expect(ensureCodeModeRepoSetup).toHaveBeenCalledWith(expect.any(String), {
      createWorkflow: true,
    });
    expect(runCodeModeConnectors).toHaveBeenCalled();
    // The augmented message from the connector pull reaches the agent run.
    const agentArgs = vi.mocked(runOpenWikiAgent).mock.calls[0];
    expect(agentArgs[2].userMessage).toBe("augmented");
    expect(process.exitCode).toBe(0);
  });

  test("prints the how-to-fix panel on an auth failure and exits 1", async () => {
    process.env.OPENWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = FAKE_SECRET;
    vi.mocked(runOpenWikiAgent).mockRejectedValue({
      status: 401,
      message: "unauthorized",
    });

    await runPrintCommand(
      makeCommand("run", {
        command: "update",
        dryRun: false,
        language: null,
        mode: "personal",
        modeSource: "default",
        modelId: null,
        print: true,
        shouldStart: false,
        userMessage: null,
        telemetryFile: null,
      }),
    );

    const errOutput = stderr.join("");
    expect(errOutput).toContain("How to fix");
    expect(errOutput).toContain("For full detail, re-run with --debug.");
    expect(errOutput).not.toContain(FAKE_SECRET);
    expect(process.exitCode).toBe(1);
  });
});

describe("writePrintErrorDiagnostics", () => {
  test("prints allowlisted labels and redacts a planted secret", () => {
    // The name/message fields are only surfaced in debug mode.
    process.env.OPENWIKI_DEBUG = "1";
    process.env.ANTHROPIC_API_KEY = FAKE_SECRET;

    const error = new Error(`request failed using key ${FAKE_SECRET}`);
    writePrintErrorDiagnostics(error);

    const output = stderr.join("");

    // Allowlisted, human-readable fields are shown...
    expect(output).toContain("Error Diagnostics");
    expect(output).toContain("name: Error");
    expect(output).toContain("message:");
    // ...but the raw secret is masked, never printed.
    expect(output).not.toContain(FAKE_SECRET);
    expect(output).toContain("[REDACTED:ANTHROPIC_API_KEY]");
  });

  test("writes nothing when there are no diagnostics", () => {
    writePrintErrorDiagnostics(undefined);
    expect(stderr.join("")).toBe("");
  });
});

describe("writePrintAuthFix", () => {
  test("prints how-to-fix guidance for an auth error without leaking secrets", () => {
    process.env.OPENWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = FAKE_SECRET;

    // A 401 marks this as an auth failure, so a fix panel is emitted.
    writePrintAuthFix({ status: 401 }, "unauthorized");

    const output = stderr.join("");

    expect(output).toContain("How to fix");
    expect(output).toContain("For full detail, re-run with --debug.");
    // Guidance references files and commands, never the secret value itself.
    expect(output).not.toContain(FAKE_SECRET);
  });

  test("writes nothing when the error is not an auth error", () => {
    writePrintAuthFix(new Error("disk full"), "disk full");
    expect(stderr.join("")).toBe("");
  });
});
