import path from "node:path";
import {
  getHostIntegrationStatus,
  installHostIntegration,
  uninstallHostIntegration,
} from "../host-integrations/install/installer.js";
import {
  getHostTarget,
  listHostTargets,
} from "../host-integrations/install/registry.js";
import { runOpenWikiMcp } from "../host-integrations/mcp/stdio.js";
import { getErrorMessage } from "../platform/diagnostics.js";
import type { CliCommand } from "./commands.js";

/**
 * Executes a registry-driven integration list, install, or uninstall command.
 *
 * @param command - Parsed integration command.
 */
export async function runIntegrationsCommand(
  command: Extract<CliCommand, { kind: "integrations" }>,
): Promise<void> {
  try {
    if (command.action === "list") {
      for (const target of listHostTargets()) {
        const status = await getHostIntegrationStatus(
          target,
          command.projectRoot,
        );
        process.stdout.write(
          `${target.id}\t${status}\t${target.displayName}\n`,
        );
      }
      process.exitCode = 0;
      return;
    }

    const target = command.target ? getHostTarget(command.target) : undefined;
    if (!target) throw new Error("Integration target is required.");
    const result =
      command.action === "install"
        ? await installHostIntegration(target, {
            projectRoot: command.projectRoot,
            force: command.force,
          })
        : await uninstallHostIntegration(target, {
            projectRoot: command.projectRoot,
          });

    process.stdout.write(
      `${result.changed ? command.action : "unchanged"} ${target.displayName}\n` +
        `skill: ${result.skillDirectory}\n` +
        `mcp: ${result.mcpConfig}\n` +
        (result.backupPath ? `backup: ${result.backupPath}\n` : ""),
    );

    if (command.action === "install") {
      process.stdout.write(
        `\nOpenWiki is ready for ${target.displayName}.\n\n` +
          "Next:\n" +
          `  1. Restart ${target.displayName} in this repository.\n` +
          "  2. Confirm the openwiki MCP server is available.\n" +
          "  3. Ask: “Initialize OpenWiki for this repository.”\n",
      );
    }
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Starts the local stdio MCP server for a parsed CLI command.
 *
 * @param command - Parsed MCP server command.
 */
export async function runMcpCommand(
  command: Extract<CliCommand, { kind: "mcp" }>,
): Promise<void> {
  await runOpenWikiMcp({
    root: path.resolve(process.cwd(), command.root),
    host: command.host,
  });
}
