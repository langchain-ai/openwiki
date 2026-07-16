import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentCliProviderConfig } from "../../constants.js";
import type { OpenWikiRunOptions } from "../types.js";
import { buildAgentCliChildEnv } from "./child-env.js";
import type { AgentCliAdapter, EngineRunSpec } from "./types.js";
import {
  findDisallowedWrites,
  formatDisallowedWritesError,
} from "./write-boundary.js";

const DEFAULT_TIMEOUT_SECONDS = 1800;
const STDERR_TAIL_LIMIT = 4000;

type RunResult = { ok: boolean; errorMessage?: string } | null;

const threadSessionIds = new Map<string, string>();

// Detached agent-CLI children live in their own process group so the timeout
// path can kill the whole group with `process.kill(-pid)`. Track live group
// leaders so exit/signal handlers can clean them up if the parent dies mid-run.
const liveProcessGroupIds = new Set<number>();
let cleanupHandlersRegistered = false;

/** Exposed for tests only. */
export function getLiveProcessGroupIdsForTesting(): ReadonlySet<number> {
  return liveProcessGroupIds;
}

function killLiveProcessGroups(): void {
  for (const pid of liveProcessGroupIds) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function registerCleanupHandlersOnce(): void {
  if (cleanupHandlersRegistered) {
    return;
  }

  cleanupHandlersRegistered = true;

  process.on("exit", () => {
    try {
      killLiveProcessGroups();
    } catch {
      // Never throw from an exit handler.
    }
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const onSignal = () => {
      try {
        killLiveProcessGroups();
      } catch {
        // Never throw from a signal handler.
      } finally {
        process.removeListener(signal, onSignal);
        process.kill(process.pid, signal);
      }
    };

    process.on(signal, onSignal);
  }
}

export function getThreadSessionId(threadId: string): string | undefined {
  return threadSessionIds.get(threadId);
}

export function setThreadSessionId(threadId: string, sessionId: string): void {
  threadSessionIds.set(threadId, sessionId);
}

export type AgentCliRunOutcome = {
  sessionId?: string;
};

export async function runAgentCli(
  adapter: AgentCliAdapter,
  providerConfig: AgentCliProviderConfig,
  spec: EngineRunSpec,
  options: OpenWikiRunOptions,
): Promise<AgentCliRunOutcome> {
  const binary =
    process.env[providerConfig.binaryEnvKey]?.trim() ||
    providerConfig.defaultBinary;
  const install = await adapter.detectInstall(binary);

  if (!install.found) {
    throw new Error(
      `Could not run the ${providerConfig.label} CLI (${binary}). ${providerConfig.installHint}`,
    );
  }

  emitDebug(
    options,
    `engine=${adapter.id} binary=${binary} version=${install.version ?? "unknown"}`,
  );

  const promptFilePath = path.join(
    os.tmpdir(),
    `openwiki-agent-cli-${randomUUID()}.md`,
  );
  await writeFile(promptFilePath, spec.prompt, {
    encoding: "utf8",
    mode: 0o600,
  });

  const timeoutSeconds = resolveTimeoutSeconds();
  const outcome: AgentCliRunOutcome = {};
  const toolNames = new Map<string, string>();
  let result: RunResult = null;
  let stderrTail = "";
  let timedOut = false;
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

  function readResult(): RunResult {
    return result;
  }

  // Capture the write-boundary clock before spawn so any file the child
  // creates/touches can be detected by mtime after the run.
  const writeBoundary = spec.writeBoundary ?? "none";
  const writeBoundarySinceMs = Date.now();

  try {
    const child = spawn(binary, adapter.buildArgs(spec, promptFilePath), {
      cwd: spec.cwd,
      detached: true,
      // Scrub credentials loaded into process.env by loadOpenWikiEnv().
      env: buildAgentCliChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    registerCleanupHandlersOnce();

    if (child.pid !== undefined) {
      liveProcessGroupIds.add(child.pid);
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      sigkillTimer = killProcessGroup(child.pid);
    }, timeoutSeconds * 1000);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });

    const streamParser = adapter.createParser();
    const streamFormat = adapter.streamFormat ?? "ndjson";

    const handleParsedEvents = (
      events: ReturnType<typeof streamParser.parse>,
    ): void => {
      for (const event of events) {
        if (event.type === "session") {
          outcome.sessionId = event.sessionId;
          continue;
        }

        if (event.type === "result") {
          result = { ok: event.ok, errorMessage: event.errorMessage };
          continue;
        }

        if (event.event.type === "tool_start") {
          toolNames.set(event.event.id, event.event.name);
          options.onEvent?.(event.event);
          continue;
        }

        if (event.event.type === "tool_end") {
          options.onEvent?.({
            ...event.event,
            name: toolNames.get(event.event.id) ?? event.event.name,
          });
          continue;
        }

        if (event.event.type === "debug") {
          emitDebug(options, event.event.message);
          continue;
        }

        options.onEvent?.(event.event);
      }
    };

    const lines = createInterface({ input: child.stdout });

    lines.on("line", (line) => {
      if (streamFormat === "text") {
        // Preserve whitespace-only lines as structure but skip pure empties.
        if (line.length === 0) {
          return;
        }

        handleParsedEvents(streamParser.parse(line));
        return;
      }

      const trimmed = line.trim();

      if (trimmed.length === 0) {
        return;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(trimmed);
      } catch {
        emitDebug(
          options,
          `engine.unparsedLine=${JSON.stringify(trimmed.slice(0, 200))}`,
        );
        return;
      }

      handleParsedEvents(streamParser.parse(parsed));
    });

    let spawnErrorMessage: string | undefined;

    const exitCodePromise = new Promise<number | null>((resolve) => {
      child.on("close", (code) => {
        if (child.pid !== undefined) {
          liveProcessGroupIds.delete(child.pid);
        }
        if (sigkillTimer !== undefined) {
          clearTimeout(sigkillTimer);
          sigkillTimer = undefined;
        }
        resolve(code);
      });
      child.on("error", (error) => {
        spawnErrorMessage = error.message;
        resolve(null);
      });
    });

    // Wait for both process exit and readline EOF so the final NDJSON line is
    // parsed before flush/success decisions (stdout may not end on a newline).
    const stdoutDone = new Promise<void>((resolve) => {
      lines.on("close", () => {
        resolve();
      });
    });

    const exitCode = await exitCodePromise;
    await stdoutDone;

    // Flush any text buffered when the process exits without a terminal `end`.
    handleParsedEvents(streamParser.flush());

    if (adapter.afterExit) {
      handleParsedEvents(
        await adapter.afterExit({ exitCode, stderrTail }),
      );
    }

    clearTimeout(timeout);

    if (timedOut) {
      throw new Error(
        `${providerConfig.label} run timed out after ${timeoutSeconds} seconds. Set OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS to allow longer runs.`,
      );
    }

    const finalResult = readResult();

    if (finalResult?.ok) {
      if (writeBoundary !== "none") {
        const disallowed = await findDisallowedWrites(
          spec.cwd,
          writeBoundarySinceMs,
          writeBoundary,
        );

        if (disallowed.length > 0) {
          throw new Error(
            formatDisallowedWritesError(providerConfig.label, disallowed),
          );
        }
      }

      return outcome;
    }

    throw new Error(
      formatRunFailure(
        providerConfig,
        finalResult,
        exitCode,
        stderrTail,
        spawnErrorMessage,
      ),
    );
  } finally {
    await unlink(promptFilePath).catch(() => {
      // Temp file may already be gone.
    });
    await adapter.cleanup?.();
  }
}

function formatRunFailure(
  providerConfig: AgentCliProviderConfig,
  result: RunResult,
  exitCode: number | null,
  stderrTail: string,
  spawnErrorMessage?: string,
): string {
  const summary =
    result?.errorMessage ??
    (spawnErrorMessage !== undefined
      ? `${providerConfig.label} run failed to start: ${spawnErrorMessage}`
      : `${providerConfig.label} run failed (exit code ${exitCode ?? "unknown"}) without reporting a result.`);
  const stderr = stderrTail.trim();
  const loginHint = /login|api key|authenticat|logged out/iu.test(
    `${summary} ${stderr}`,
  )
    ? ` ${providerConfig.installHint}`
    : "";

  return `${summary}${loginHint}${stderr.length > 0 ? `\nstderr: ${stderr}` : ""}`;
}

function resolveTimeoutSeconds(): number {
  const raw = process.env.OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_TIMEOUT_SECONDS;
}

/**
 * Sends SIGTERM to the process group, then schedules SIGKILL. Returns the
 * SIGKILL timer so callers can clear it if the child exits cleanly.
 */
function killProcessGroup(
  pid: number | undefined,
): ReturnType<typeof setTimeout> | undefined {
  if (pid === undefined) {
    return undefined;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The process may already have exited.
  }

  return setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }, 5000).unref();
}

function emitDebug(options: OpenWikiRunOptions, message: string): void {
  if (!options.debug) {
    return;
  }

  options.onEvent?.({ type: "debug", message });
}
