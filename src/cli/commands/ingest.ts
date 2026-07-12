import type { CliCommand } from "../../commands.js";
import { getErrorMessage } from "../../diagnostics.js";
import { runOpenWikiIngestion } from "../../ingestion.js";
import { isDebugMode } from "../../ui/format.js";
import { writePrintErrorDiagnostics } from "../error-diagnostics.js";

/**
 * Runs the `openwiki ingest` command: ingests the requested connector(s),
 * streaming main output to stdout, prints a per-source summary, and sets the
 * exit code (1 if any source errored).
 */
export async function runIngestCommand(
  command: Extract<CliCommand, { kind: "ingest" }>,
): Promise<void> {
  try {
    const result = await runOpenWikiIngestion(process.cwd(), {
      debug: isDebugMode(),
      modelId: command.modelId,
      scheduledOnly: command.scheduledOnly,
      target: command.target,
      onEvent: (event) => {
        if (event.type === "text" && event.source !== "subgraph") {
          process.stdout.write(event.text);
        }
      },
    });

    process.stdout.write("\nIngestion summary\n");
    for (const sourceResult of result.results) {
      process.stdout.write(
        `- ${sourceResult.displayName}: ${sourceResult.status}; ${sourceResult.rawFiles.length} raw file(s)\n`,
      );
    }

    process.exitCode = result.results.some(
      (sourceResult) => sourceResult.status === "error",
    )
      ? 1
      : 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    writePrintErrorDiagnostics(error);
    process.exitCode = 1;
  }
}
