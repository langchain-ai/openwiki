import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  getProviderCliCommand,
  getProviderLabel,
  providerUsesCliAuth,
  resolveCliTimeoutSeconds,
  type OpenWikiProvider,
} from "../../constants.js";
import {
  createOpenWikiContentSnapshot,
  createRunContext,
  writeLastUpdateMetadata,
} from "../utils.js";
import type {
  OpenWikiCommand,
  OpenWikiRunOptions,
  OpenWikiRunResult,
} from "../types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { createCliSystemPrompt, createCliUserPrompt } from "./prompt.js";
import { getCliSession, saveCliSession } from "./sessions.js";
import type { CliEngineAdapter, CliRunSpec } from "./types.js";

const execFileAsync = promisify(execFile);

const CLI_INSTALL_HINTS: Record<string, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
};

export async function ensureCliBinaryAvailable(
  provider: OpenWikiProvider,
): Promise<void> {
  const cliCommand = getProviderCliCommand(provider);

  if (!providerUsesCliAuth(provider) || !cliCommand) {
    throw new Error(`${provider} is not a CLI-based provider.`);
  }

  try {
    await execFileAsync(cliCommand, ["--version"], { timeout: 10_000 });
  } catch (error) {
    if (isSpawnNotFoundError(error)) {
      const hint = CLI_INSTALL_HINTS[cliCommand];

      throw new Error(
        `${cliCommand} CLI not found. Install it${hint ? ` with: ${hint}` : ""} and sign in, then retry. It is required to run OpenWiki with ${getProviderLabel(provider)}.`,
        { cause: error },
      );
    }

    throw error;
  }
}

function isSpawnNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function getEngineAdapter(provider: OpenWikiProvider): CliEngineAdapter {
  if (provider === "claude-code") {
    return claudeAdapter;
  }

  if (provider === "codex-cli") {
    return codexAdapter;
  }

  throw new Error(`No CLI engine adapter for provider ${provider}.`);
}

export async function runOpenWikiCliAgent(
  command: OpenWikiCommand,
  cwd: string,
  options: OpenWikiRunOptions,
  run: { modelId: string; provider: OpenWikiProvider },
): Promise<OpenWikiRunResult> {
  const outputMode = options.outputMode ?? "local-wiki";
  const model = `${run.provider}/${run.modelId}`;
  const adapter = getEngineAdapter(run.provider);
  const context = await createRunContext(command, cwd, outputMode);
  const snapshotBefore =
    command === "chat"
      ? null
      : await createOpenWikiContentSnapshot(cwd, outputMode);

  emitDebug(options, `cli.engine=${run.provider} model=${run.modelId}`);

  const resumeSessionId =
    options.isFollowup === true && options.threadId
      ? await getCliSession(options.threadId, run.provider)
      : null;

  const spec: CliRunSpec = {
    command,
    cwd,
    modelId: run.modelId,
    outputMode,
    resumeSessionId,
    systemPrompt: createCliSystemPrompt(command, outputMode, run.provider),
    userPrompt: createCliUserPrompt(command, cwd, context, options, outputMode),
  };

  const result = await executeCliRun(adapter, spec, options);

  if (options.threadId && result.sessionId) {
    await saveCliSession(options.threadId, run.provider, result.sessionId);
  }

  if (
    command !== "chat" &&
    snapshotBefore !== (await createOpenWikiContentSnapshot(cwd, outputMode))
  ) {
    await writeLastUpdateMetadata(command, cwd, model, outputMode);
    emitDebug(options, "cli.metadata=written");
  }

  return { command, model };
}

export async function executeCliRun(
  adapter: CliEngineAdapter,
  spec: CliRunSpec,
  options: OpenWikiRunOptions,
  spawnCommand: string = adapter.cliCommand,
): Promise<{ sessionId: string | null }> {
  try {
    return await executeCliRunOnce(adapter, spec, options, spawnCommand);
  } catch (error) {
    if (!spec.resumeSessionId) {
      throw error;
    }

    // Expired/unknown sessions surface as CLI failures; fall back to a
    // fresh session once.
    emitDebug(
      options,
      `cli.resume failed (${getErrorMessage(error)}); retrying with a new session`,
    );

    return executeCliRunOnce(
      adapter,
      { ...spec, resumeSessionId: null },
      options,
      spawnCommand,
    );
  }
}

async function executeCliRunOnce(
  adapter: CliEngineAdapter,
  spec: CliRunSpec,
  options: OpenWikiRunOptions,
  spawnCommand: string,
): Promise<{ sessionId: string | null }> {
  const timeoutMs = resolveCliTimeoutSeconds() * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn(spawnCommand, adapter.buildArgs(spec), {
      cwd: spec.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let sessionId: string | null = null;
    let resultError: string | null = null;
    let stderrTail = "";
    let settled = false;
    let timedOut = false;
    const toolNames = new Map<string, string>();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);

    const settle = (error: Error | null) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (error) {
        reject(error);
      } else {
        resolve({ sessionId });
      }
    };

    child.on("error", (error) => settle(error));

    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2048);
    });

    const lines = createInterface({ input: child.stdout });

    lines.on("line", (line) => {
      for (const parsed of adapter.parseLine(line)) {
        if (parsed.kind === "session") {
          sessionId = parsed.sessionId;
        } else if (parsed.kind === "result") {
          if (parsed.isError) {
            resultError = parsed.message || "CLI agent reported an error.";
          }
        } else if (parsed.kind === "event") {
          const event = parsed.event;

          if (event.type === "tool_start") {
            toolNames.set(event.id, event.name);
          }

          if (event.type === "debug" && options.debug !== true) {
            continue;
          }

          options.onEvent?.(
            event.type === "tool_end" && event.name === "tool"
              ? { ...event, name: toolNames.get(event.id) ?? event.name }
              : event,
          );
        }
      }
    });

    child.on("close", (code) => {
      if (timedOut) {
        settle(
          new Error(
            `${spawnCommand} run timed out after ${timeoutMs / 1000}s and was killed.`,
          ),
        );
      } else if (code !== 0) {
        settle(
          new Error(
            `${spawnCommand} exited with exit code ${code ?? "unknown"}.${
              stderrTail ? `\nstderr:\n${stderrTail}` : ""
            }`,
          ),
        );
      } else if (resultError) {
        settle(new Error(`CLI agent failed: ${resultError}`));
      } else {
        settle(null);
      }
    });

    child.stdin.write(adapter.stdinPayload(spec));
    child.stdin.end();
  });
}

function emitDebug(options: OpenWikiRunOptions, message: string): void {
  if (options.debug === true) {
    options.onEvent?.({ type: "debug", message });
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
