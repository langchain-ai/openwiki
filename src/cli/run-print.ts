import { createOpenWikiThreadId, runOpenWikiAgent } from "../agent/index.js";
import { ensureCodeModeRepoSetup } from "../code-mode.js";
import type { CliCommand } from "../commands.js";
import { getErrorMessage } from "../diagnostics.js";
import { isDebugMode } from "../ui/format.js";
import { writePrintErrorDiagnostics } from "./error-diagnostics.js";
import { getRunModeCwd, getRunModeOutputMode } from "./run-mode.js";

/**
 * Runs a documentation run non-interactively (invoked for `--print` or a
 * non-TTY stdin). Streams main-graph text to stdout and sets the exit code.
 */
export async function runPrintCommand(
  command: Extract<CliCommand, { kind: "run" }>,
): Promise<void> {
  try {
    const output: string[] = [];

    const runtimeCwd = getRunModeCwd(command.mode);
    const runtimeOutputMode = getRunModeOutputMode(command.mode);

    if (command.mode === "code") {
      await ensureCodeModeRepoSetup(runtimeCwd);
    }

    await runOpenWikiAgent(command.command, runtimeCwd, {
      debug: isDebugMode(),
      isFollowup: command.command === "chat",
      modelId: command.modelId,
      outputMode: runtimeOutputMode,
      threadId: createOpenWikiThreadId(runtimeCwd),
      userMessage: command.userMessage,
      onEvent: (event) => {
        if (event.type === "text" && event.source !== "subgraph") {
          output.push(event.text);
        }
      },
    });

    const text = output.join("").trim();

    if (text.length > 0) {
      process.stdout.write(`${text}\n`);
    }

    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    writePrintErrorDiagnostics(error);
    process.exitCode = 1;
  }
}
