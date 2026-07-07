import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSystemPrompt, createUserPrompt } from "./agent/prompt.js";
import type {
  OpenWikiCommand,
  OpenWikiRunOptions,
  OpenWikiRunResult,
} from "./agent/types.js";
import {
  createOpenWikiContentSnapshot,
  createRunContext,
  getUpdateNoopStatus,
  shouldCheckUpdateNoop,
  writeLastUpdateMetadata,
} from "./agent/utils.js";

const CODEX_RUNNER_MODEL = "codex";

export async function runOpenWikiWithCodex(
  command: OpenWikiCommand,
  cwd = process.cwd(),
  options: OpenWikiRunOptions = {},
): Promise<OpenWikiRunResult> {
  options.onEvent?.({
    type: "debug",
    message: "runner=codex",
  });

  if (command === "update" && shouldCheckUpdateNoop(options)) {
    const noopStatus = await getUpdateNoopStatus(cwd);

    if (noopStatus.shouldSkip) {
      const message =
        "No repository changes detected since the last OpenWiki update; skipping Codex run.";
      options.onEvent?.({ type: "text", text: message });

      return {
        command,
        model: noopStatus.model,
        skipped: true,
      };
    }
  }

  const openWikiSnapshotBefore =
    command === "chat" ? null : await createOpenWikiContentSnapshot(cwd);
  const context = await createRunContext(command, cwd);
  const prompt = createCodexPrompt(command, cwd, context, options);
  const outputFile = await createOutputFilePath();

  try {
    options.onEvent?.({
      type: "text",
      text: "Starting local `codex exec` runner with saved Codex authentication.",
    });

    await runCodexExec(cwd, prompt, outputFile, options);

    const finalMessage = await readFile(outputFile, "utf8").catch(() => "");
    if (finalMessage.trim()) {
      options.onEvent?.({ type: "text", text: finalMessage.trim() });
    }

    if (
      command !== "chat" &&
      openWikiSnapshotBefore !== (await createOpenWikiContentSnapshot(cwd))
    ) {
      await writeLastUpdateMetadata(command, cwd, CODEX_RUNNER_MODEL);
      options.onEvent?.({
        type: "debug",
        message: "metadata=written runner=codex",
      });
    }

    return {
      command,
      model: CODEX_RUNNER_MODEL,
    };
  } finally {
    await rm(path.dirname(outputFile), { recursive: true, force: true });
  }
}

function createCodexPrompt(
  command: OpenWikiCommand,
  cwd: string,
  context: Awaited<ReturnType<typeof createRunContext>>,
  options: OpenWikiRunOptions,
): string {
  const userPrompt =
    options.isFollowup === true && options.userMessage?.trim()
      ? options.userMessage.trim()
      : createUserPrompt(command, context, options.userMessage ?? null);

  return `
${createSystemPrompt(command)}

${userPrompt}

Repository root:
${cwd}

Codex runner note:
- You are running through OpenWiki's local Codex runner.
- Operate only in the repository root above.
- Use normal filesystem paths relative to that repository.
- Keep all generated documentation under openwiki/.
- Do not read .env files, credentials, private keys, tokens, or other secret-bearing files.
- Before completing init/update, verify the openwiki/ tree and remove openwiki/_plan.md if it exists.
`.trim();
}

async function createOutputFilePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "openwiki-codex-"));
  return path.join(directory, "last-message.md");
}

function runCodexExec(
  cwd: string,
  prompt: string,
  outputFile: string,
  options: OpenWikiRunOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "--cd",
      cwd,
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
    ];

    if (options.modelId) {
      args.push("--model", options.modelId);
    }

    args.push("exec", "--ephemeral", "--output-last-message", outputFile, "-");

    const child = spawn("codex", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (options.debug) {
        options.onEvent?.({
          type: "debug",
          message: `codex.stdout ${chunk.trim()}`,
        });
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      const trimmed = chunk.trim();
      if (trimmed && options.debug) {
        options.onEvent?.({
          type: "debug",
          message: `codex.stderr ${trimmed}`,
        });
      }
    });

    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        reject(error);
      }
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `codex exec exited with code ${code ?? "unknown"}${
            stderr.trim() ? `: ${stderr.trim()}` : ""
          }`,
        ),
      );
    });

    child.stdin.end(prompt);
  });
}
