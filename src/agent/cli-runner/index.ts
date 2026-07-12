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
  // Baseline for the out-of-wiki write guard: update runs deliberately
  // proceed on dirty trees, so pre-existing changes must not be attributed
  // to the CLI agent. null (not a git repo / git failed) disables the guard.
  const writeGuardBaseline =
    command !== "chat" && outputMode === "repository"
      ? await captureGitPorcelain(cwd, options)
      : null;

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

  // The API backend structurally blocks non-doc writes, but the CLI path only
  // relies on the prompt plus allowedTools/sandbox, and the wiki snapshot above
  // cannot see source-file mutations. Repository runs must only touch openwiki/;
  // warn (never fail) if the CLI changed anything else beyond the pre-run
  // baseline. Local-wiki mode writes the wiki dir itself, so there is nothing
  // to guard.
  if (writeGuardBaseline !== null) {
    await warnOnOutOfWikiWrites(cwd, writeGuardBaseline, options);
  }

  return { command, model };
}

const WIKI_DIR_PREFIX = "openwiki/";

const OUT_OF_WIKI_WARNING_LIMIT = 10;

/**
 * Compares two `git status --porcelain` (v1) captures and returns changed
 * paths OUTSIDE the generated wiki directory (openwiki/) that appear in the
 * post-run output but were not already dirty in the pre-run baseline, so
 * pre-existing dirty-tree changes are never attributed to the CLI agent.
 * Handles the rename form `R  old -> new` (both sides are checked, so moving
 * a source file into openwiki/ is still flagged) and C-quoted paths
 * (core.quotePath). Duplicate paths are collapsed, preserving first-seen
 * order.
 */
export function findUnexpectedChanges(
  baselinePorcelain: string,
  porcelainOutput: string,
): string[] {
  const baseline = new Set(collectOutOfWikiPaths(baselinePorcelain));

  return collectOutOfWikiPaths(porcelainOutput).filter(
    (filePath) => !baseline.has(filePath),
  );
}

function collectOutOfWikiPaths(porcelainOutput: string): string[] {
  const outOfWiki: string[] = [];

  for (const rawLine of porcelainOutput.split("\n")) {
    if (rawLine.trim().length === 0) {
      continue;
    }

    for (const filePath of extractPorcelainPaths(rawLine)) {
      if (
        !filePath.startsWith(WIKI_DIR_PREFIX) &&
        !outOfWiki.includes(filePath)
      ) {
        outOfWiki.push(filePath);
      }
    }
  }

  return outOfWiki;
}

function extractPorcelainPaths(line: string): string[] {
  // Porcelain v1 lines are "XY <path>" or "XY <old> -> <new>": two status
  // columns plus a separating space, so the path section starts at index 3.
  const status = line.slice(0, 2);
  const pathSection = line.slice(3);
  // Rename/copy entries (X or Y is R/C) encode both paths as "old -> new".
  // Git only C-quotes paths containing control characters, '"', '\', or
  // non-ASCII bytes, so a filename containing a literal " -> " stays
  // unquoted; gating the split on rename/copy status keeps such paths intact
  // on ordinary lines. A rename whose own paths contain " -> " can still
  // mis-split, which at worst garbles the warning text.
  const tokens =
    /[RC]/.test(status) && pathSection.includes(" -> ")
      ? pathSection.split(" -> ")
      : [pathSection];

  return tokens
    .map((token) => unquotePorcelainPath(token))
    .filter((token) => token.length > 0);
}

function unquotePorcelainPath(token: string): string {
  const trimmed = token.trim();

  if (
    !trimmed.startsWith('"') ||
    !trimmed.endsWith('"') ||
    trimmed.length < 2
  ) {
    return trimmed;
  }

  // C-style quoting: decode the common escapes. Any octal byte escapes are
  // left as-is; the openwiki/ prefix check only needs the leading, never-
  // escaped path segment.
  return trimmed
    .slice(1, -1)
    .replace(/\\([\\"])/g, "$1")
    .replace(/\\t/g, "\t")
    .replace(/\\n/g, "\n");
}

async function captureGitPorcelain(
  cwd: string,
  options: OpenWikiRunOptions,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd,
      timeout: 10_000,
    });

    return stdout;
  } catch (error) {
    // Not a git repo, git missing, or git failed: nothing to guard against.
    emitDebug(options, `cli.write-guard skipped (${getErrorMessage(error)})`);

    return null;
  }
}

async function warnOnOutOfWikiWrites(
  cwd: string,
  baselinePorcelain: string,
  options: OpenWikiRunOptions,
): Promise<void> {
  const porcelain = await captureGitPorcelain(cwd, options);

  if (porcelain === null) {
    return;
  }

  const unexpected = findUnexpectedChanges(baselinePorcelain, porcelain);

  if (unexpected.length === 0) {
    return;
  }

  const shown = unexpected.slice(0, OUT_OF_WIKI_WARNING_LIMIT);
  const overflow = unexpected.length - shown.length;
  const list = shown.map((filePath) => `  - ${filePath}`).join("\n");
  const suffix = overflow > 0 ? `\n  ...and ${overflow} more` : "";

  options.onEvent?.({
    type: "text",
    text:
      "WARNING: the CLI agent changed files outside the openwiki/ wiki directory. " +
      "OpenWiki repository runs should only write generated pages under openwiki/. " +
      `Review these unexpected changes:\n${list}${suffix}`,
  });
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

    let killTimer: NodeJS.Timeout | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    }, timeoutMs);

    const settle = (error: Error | null) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (killTimer) {
        clearTimeout(killTimer);
      }

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
        const base = `${spawnCommand} exited with exit code ${code ?? "unknown"}.${
          stderrTail ? `\nstderr:\n${stderrTail}` : ""
        }`;
        const hint = AUTH_ERROR_PATTERN.test(stderrTail)
          ? authLoginHint(adapter.engine)
          : null;

        settle(new Error(hint ? `${base}\n${hint}` : base));
      } else if (resultError) {
        settle(new Error(`CLI agent failed: ${resultError}`));
      } else {
        settle(null);
      }
    });

    // The CLI can exit before consuming stdin (e.g. an instant auth
    // failure), so flushing the prompt hits a closed pipe and emits EPIPE
    // on the stdin stream, which child.on("error") does not cover. Without
    // a listener that becomes an uncaughtException that crashes the whole
    // process. Swallow stdin errors and let the close handler settle with
    // the more informative exit-code/stderr failure.
    child.stdin.on("error", () => {});

    child.stdin.write(adapter.stdinPayload(spec));
    child.stdin.end();
  });
}

const AUTH_ERROR_PATTERN =
  /\b(log ?in|logged ?out|unauthorized|authentication|credential|api key)\b/i;

/**
 * Returns the engine-specific "sign in" hint appended to auth-flavored CLI
 * failures, or null for engines without a known login command.
 */
function authLoginHint(engine: OpenWikiProvider): string | null {
  if (engine === "claude-code") {
    return "If you are not signed in, run: claude /login";
  }

  if (engine === "codex-cli") {
    return "If you are not signed in, run: codex login";
  }

  return null;
}

function emitDebug(options: OpenWikiRunOptions, message: string): void {
  if (options.debug === true) {
    options.onEvent?.({ type: "debug", message });
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
