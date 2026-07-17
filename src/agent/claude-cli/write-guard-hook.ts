#!/usr/bin/env node
import { evaluateWritePath } from "./write-guard.js";

/**
 * Claude Code PreToolUse hook entrypoint for the claude-cli provider.
 *
 * Wired via a generated `.claude/settings.json` with a "Write|Edit" matcher.
 * Reads the standard PreToolUse JSON payload from stdin and exits 2 (which
 * Claude Code treats as "deny, feed stderr back to the model") for any write
 * outside CLAUDE_CLI_ALLOWED_DIR. Any malformed input or missing config fails
 * closed (deny) rather than silently allowing the write through.
 */

interface PreToolUseHookInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function deny(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const repoRoot = process.env.CLAUDE_CLI_REPO_ROOT;
  if (!repoRoot) {
    deny(
      "claude-cli write guard misconfigured: CLAUDE_CLI_REPO_ROOT is not set.",
    );
  }
  const allowedRelativeDir = process.env.CLAUDE_CLI_ALLOWED_DIR ?? "openwiki";

  const raw = await readStdin();
  let input: PreToolUseHookInput;
  try {
    input = JSON.parse(raw) as PreToolUseHookInput;
  } catch {
    deny("claude-cli write guard: could not parse PreToolUse hook payload.");
    return;
  }

  if (input.tool_name !== "Write" && input.tool_name !== "Edit") {
    process.exit(0);
    return;
  }

  const filePath = input.tool_input?.file_path;
  if (!filePath) {
    deny(
      `claude-cli write guard: ${input.tool_name} call had no file_path in tool_input.`,
    );
    return;
  }

  const decision = evaluateWritePath({
    repoRoot,
    allowedRelativeDir,
    filePath,
    cwd: input.cwd,
  });

  if (!decision.allowed) {
    deny(decision.reason ?? "claude-cli write guard: write refused.");
    return;
  }

  process.exit(0);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  deny(`claude-cli write guard crashed: ${message}`);
});
