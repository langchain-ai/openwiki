import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentCliAdapter,
  AgentCliEvent,
  AgentCliExitInfo,
  AgentCliInstallStatus,
  AgentCliStreamParser,
  EngineRunSpec,
} from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Match the glog line printmode.go writes when the CLI dispatches the user's
 * message — the only place in the log that reliably surfaces the conversation
 * UUID for both fresh and resumed turns.
 *
 * Example: `Print mode: conversation=b8b263a4-4b2f-4339-acc9-78b248e2b606, sending message`
 */
const CONVERSATION_ID_RE =
  /conversation=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/gu;

/** agy print-mode wall-clock timeout marker (exit code may still be 0). */
const PRINT_TIMEOUT_RE = /Print mode: timed out after \d+ polls/u;

const PROVIDER_ERROR_RE = /agent executor error:\s*(.+)/gu;

/**
 * Antigravity (`agy`) headless adapter.
 *
 * Auth is the CLI's own subscription / Google login — OpenWiki never stores an
 * API key. Print mode (`agy -p`) emits plain assistant text on stdout (not
 * NDJSON). Session resume uses `--conversation <id>`, recovered from a
 * per-run `--log-file`.
 *
 * Model ids are the exact display strings from `agy models` (e.g.
 * `Gemini 3.5 Flash (Medium)`), not provider/model slugs.
 */
export function createAntigravityAdapter(): AgentCliAdapter {
  let logFilePath: string | undefined;
  let sawStdoutText = false;
  let finished = false;

  return {
    id: "antigravity",
    streamFormat: "text",

    async detectInstall(binary: string): Promise<AgentCliInstallStatus> {
      try {
        const { stdout } = await execFileAsync(binary, ["--version"], {
          timeout: 15_000,
        });

        return { found: true, version: stdout.trim().split("\n")[0]?.trim() };
      } catch {
        return { found: false };
      }
    },

    buildArgs(spec: EngineRunSpec, promptFilePath: string): string[] {
      const prompt = readFileSync(promptFilePath, "utf8");
      logFilePath = path.join(
        os.tmpdir(),
        `openwiki-agy-log-${randomUUID()}.log`,
      );

      const args = [
        "-p",
        prompt,
        "--dangerously-skip-permissions",
        "--mode",
        "accept-edits",
        "--print-timeout",
        formatPrintTimeout(resolvePrintTimeoutSeconds()),
        "--log-file",
        logFilePath,
        "--add-dir",
        path.resolve(spec.cwd),
      ];

      if (spec.modelId.length > 0) {
        args.push("--model", spec.modelId);
      }

      if (spec.resumeSessionId) {
        args.push("--conversation", spec.resumeSessionId);
      }

      return args;
    },

    createParser(): AgentCliStreamParser {
      return {
        parse(line: unknown): AgentCliEvent[] {
          if (finished || typeof line !== "string") {
            return [];
          }

          // Skip the print-mode timeout/error lines that agy writes to stdout
          // with a still-zero exit code; afterExit classifies those via the log.
          if (
            line.startsWith("Error: timeout waiting for response") ||
            line.startsWith("Error: timed out waiting for response")
          ) {
            return [];
          }

          sawStdoutText = true;

          return [
            {
              type: "openwiki",
              event: { source: "main", type: "text", text: `${line}\n` },
            },
          ];
        },

        flush(): AgentCliEvent[] {
          return [];
        },
      };
    },

    async afterExit(info: AgentCliExitInfo): Promise<AgentCliEvent[]> {
      if (finished) {
        return [];
      }

      finished = true;
      const events: AgentCliEvent[] = [];
      const logContents = logFilePath
        ? await readFile(logFilePath, "utf8").catch(() => "")
        : "";

      const sessionId = extractConversationId(logContents);

      if (sessionId) {
        events.push({ type: "session", sessionId });
      }

      if (PRINT_TIMEOUT_RE.test(logContents)) {
        events.push({
          type: "result",
          ok: false,
          errorMessage:
            "Antigravity print mode timed out waiting for a response. Increase OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS (controls --print-timeout).",
        });
        return events;
      }

      const providerError = extractProviderError(logContents);

      if (providerError) {
        events.push({
          type: "result",
          ok: false,
          errorMessage: `Antigravity provider error: ${providerError}`,
        });
        return events;
      }

      if (info.exitCode !== 0 && info.exitCode !== null) {
        events.push({
          type: "result",
          ok: false,
          errorMessage: `Antigravity run failed (exit code ${info.exitCode}).`,
        });
        return events;
      }

      // agy can finish a turn (tools + reply) while emitting zero stdout bytes.
      // Recover the assistant text from the conversation transcript when we
      // have a session id and saw nothing on stdout.
      if (!sawStdoutText && sessionId && logFilePath) {
        const recovered = await recoverTranscriptText(logFilePath, sessionId);

        if (recovered.trim().length > 0) {
          events.push({
            type: "openwiki",
            event: { source: "main", type: "text", text: recovered },
          });
        }
      }

      events.push({ type: "result", ok: true });
      return events;
    },

    async cleanup(): Promise<void> {
      if (!logFilePath) {
        return;
      }

      await unlink(logFilePath).catch(() => {
        // Log may already be gone.
      });
      logFilePath = undefined;
    },
  };
}

/** Singleton for simple detectInstall/buildArgs unit tests. */
export const antigravityAdapter: AgentCliAdapter = createAntigravityAdapter();

/** Exported for tests. */
export function extractConversationId(logContents: string): string | undefined {
  let last: string | undefined;

  for (const match of logContents.matchAll(CONVERSATION_ID_RE)) {
    last = match[1];
  }

  return last;
}

/** Exported for tests. */
export function extractProviderError(logContents: string): string | undefined {
  let last: string | undefined;

  for (const match of logContents.matchAll(PROVIDER_ERROR_RE)) {
    last = match[1]?.trim();
  }

  return last && last.length > 0 ? last : undefined;
}

/** Exported for tests. */
export function formatPrintTimeout(totalSeconds: number): string {
  const seconds = Math.max(1, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;

  return `${minutes}m${rem}s`;
}

function resolvePrintTimeoutSeconds(): number {
  const raw = process.env.OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);

  // Align with the runner's default 1800s wall clock so agy's own print-timeout
  // does not guillotine the run at the 5m default while the parent is still waiting.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1800;
}

async function recoverTranscriptText(
  logPath: string,
  conversationId: string,
): Promise<string> {
  const logContents = await readFile(logPath, "utf8").catch(() => "");
  const appDataDir = extractAppDataDir(logContents);

  if (!appDataDir) {
    return "";
  }

  const transcriptPath = path.join(
    appDataDir,
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );

  const contents = await readFile(transcriptPath, "utf8").catch(() => "");

  if (contents.length === 0) {
    return "";
  }

  const parts: string[] = [];

  for (const line of contents.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }

    let record: {
      type?: string;
      source?: string;
      status?: string;
      content?: unknown;
    };

    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }

    if (record.type === "USER_INPUT") {
      // New turn boundary — only keep the current turn's model text.
      parts.length = 0;
      continue;
    }

    if (
      record.type !== "PLANNER_RESPONSE" ||
      record.source !== "MODEL" ||
      record.status !== "DONE" ||
      typeof record.content !== "string" ||
      record.content.trim().length === 0
    ) {
      continue;
    }

    parts.push(record.content);
  }

  return parts.join("\n\n");
}

function extractAppDataDir(logContents: string): string | undefined {
  const match = /CLI app data directory:\s*(.+)/u.exec(logContents);

  return match?.[1]?.trim();
}
