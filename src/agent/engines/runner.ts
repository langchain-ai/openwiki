import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentCliProviderConfig } from "../../constants.js";
import type { OpenWikiRunOptions } from "../types.js";
import type { AgentCliAdapter, EngineRunSpec } from "./types.js";

const DEFAULT_TIMEOUT_SECONDS = 1800;
const STDERR_TAIL_LIMIT = 4000;

type RunResult = { ok: boolean; errorMessage?: string } | null;

const threadSessionIds = new Map<string, string>();

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

  const timeoutSeconds = resolveTimeoutSeconds();
  const outcome: AgentCliRunOutcome = {};
  const toolNames = new Map<string, string>();
  let result: RunResult = null;
  let stderrTail = "";
  let timedOut = false;

  // `result` is assigned inside the readline "line" listener closure below.
  // TypeScript's control-flow analysis does not track that mutation, so a
  // direct read of `result` after the closure has run gets (incorrectly)
  // narrowed to `null`. Routing the read through a function whose return
  // type is explicitly annotated resets the type to the declared union.
  function readResult(): RunResult {
    return result;
  }

  const child = spawn(binary, adapter.buildArgs(spec), {
    cwd: spec.cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child.pid);
  }, timeoutSeconds * 1000);

  child.stdin.write(spec.prompt);
  child.stdin.end();

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
  });

  const lines = createInterface({ input: child.stdout });

  lines.on("line", (line) => {
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

    for (const event of adapter.parseEvent(parsed)) {
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
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });

  clearTimeout(timeout);

  if (timedOut) {
    throw new Error(
      `${providerConfig.label} run timed out after ${timeoutSeconds} seconds. Set OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS to allow longer runs.`,
    );
  }

  const finalResult = readResult();

  if (finalResult?.ok) {
    return outcome;
  }

  throw new Error(
    formatRunFailure(providerConfig, finalResult, exitCode, stderrTail),
  );
}

function formatRunFailure(
  providerConfig: AgentCliProviderConfig,
  result: RunResult,
  exitCode: number | null,
  stderrTail: string,
): string {
  const summary =
    result?.errorMessage ??
    `${providerConfig.label} run failed (exit code ${exitCode ?? "unknown"}) without reporting a result.`;
  const stderr = stderrTail.trim();
  const loginHint = /login|api key|authenticat/iu.test(`${summary} ${stderr}`)
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

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The process may already have exited.
  }

  setTimeout(() => {
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
