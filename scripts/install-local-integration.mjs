import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  defaultMcpServerCommand,
  installHostIntegration,
} from "../dist/host-integrations/install/installer.js";
import { getHostTarget } from "../dist/host-integrations/install/registry.js";
import { getErrorMessage } from "../dist/platform/diagnostics.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
/**
 * Installs one global host integration backed by this source checkout.
 *
 * @returns {Promise<void>} Completion after the skill and MCP config are installed.
 */
async function main() {
  const hostId = process.argv[2];
  const target = hostId ? getHostTarget(hostId) : undefined;
  if (!target || process.argv.length !== 3) {
    throw new Error("Usage: pnpm integration:dev <codex|claude|dcode>");
  }

  const mcpServerCommand = {
    command: process.execPath,
    args: [
      path.join(repositoryRoot, "dist", "cli", "cli.js"),
      "mcp",
      "--host",
      target.id,
    ],
  };
  const result = await installHostIntegration(target, {
    scope: "user",
    root: os.homedir(),
    mcpServerCommand,
    replaceMcpServerCommand: defaultMcpServerCommand(target),
  });

  process.stdout.write(
    `${result.changed ? "installed" : "unchanged"} ${target.displayName} local development integration\n` +
      `skill: ${result.skillDirectory}\n` +
      `mcp: ${result.mcpConfig}\n` +
      `server: ${mcpServerCommand.command} ${mcpServerCommand.args.join(" ")}\n` +
      `\nRestart ${target.displayName} to use this checkout.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${getErrorMessage(error)}\n`);
  process.exitCode = 1;
});
