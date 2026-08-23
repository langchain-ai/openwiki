import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { installHostIntegration } from "../dist/integrations/install/installer.js";
import { getHostTarget } from "../dist/integrations/install/registry.js";
import { getErrorMessage } from "../dist/platform/diagnostics.js";

/**
 * Installs one host integration backed by this source checkout.
 *
 * @returns {Promise<void>} Completion after the skill and MCP config are installed.
 */
async function main() {
  const hostId = process.argv[2];
  const target = hostId ? getHostTarget(hostId) : undefined;
  if (!target || process.argv.length !== 3) {
    throw new Error("Usage: pnpm integrations:dev <codex|claude|opencode>");
  }

  const repositoryRoot = await realpath(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const mcpServerCommand = {
    command: await realpath(process.execPath),
    args: [
      await realpath(path.join(repositoryRoot, "dist", "cli", "cli.js")),
      "mcp",
      "--host",
      target.id,
    ],
  };
  const result = await installHostIntegration(target, {
    scope: target.user ? "user" : "project",
    root: target.user ? os.homedir() : repositoryRoot,
    mcpServerCommand,
  });

  process.stdout.write(
    `${result.changed ? "installed" : "unchanged"} ${target.displayName} local development integration\n` +
      `skill: ${result.skillDirectory}\n` +
      `mcp: ${result.mcpConfig}\n` +
      `server: ${mcpServerCommand.command} ${mcpServerCommand.args.join(" ")}\n` +
      `\nRestart ${target.displayName}${target.user ? "" : " in this repository"} to use this checkout.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${getErrorMessage(error)}\n`);
  process.exitCode = 1;
});
