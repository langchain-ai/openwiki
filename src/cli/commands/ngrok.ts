import { startNgrokTunnel } from "../../auth/ngrok.js";
import type { CliCommand } from "../../commands.js";
import { getErrorMessage } from "../../diagnostics.js";

/**
 * Runs the `openwiki ngrok` command: opens an ngrok tunnel for the requested
 * port/url and sets the process exit code (0 on success, 1 on failure).
 */
export async function runNgrokCommand(
  command: Extract<CliCommand, { kind: "ngrok" }>,
): Promise<void> {
  try {
    await startNgrokTunnel({
      port: command.port,
      url: command.url,
    });
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
