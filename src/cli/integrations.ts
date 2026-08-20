import os from "node:os";
import {
  getHostIntegrationStatus,
  installHostIntegration,
  uninstallHostIntegration,
} from "../integrations/install/installer.js";
import {
  getHostTarget,
  listHostTargets,
} from "../integrations/install/registry.js";
import { runOpenWikiMcp } from "../integrations/mcp/stdio.js";
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
    const root =
      command.scope === "user" ? os.homedir() : (command.projectRoot ?? ".");
    if (command.action === "list") {
      const targets = listHostTargets();
      const rows = await Promise.all(
        targets.map(async (target) => {
          const status = await getHostIntegrationStatus(target, {
            scope: command.scope,
            root,
          });
          return `${target.id}\t${status}\t${target.displayName}`;
        }),
      );
      process.stdout.write(`${rows.join("\n")}\n`);
      process.exitCode = 0;
      return;
    }

    const target = command.target ? getHostTarget(command.target) : undefined;
    if (!target) throw new Error("Integration target is required.");
    const result =
      command.action === "install"
        ? await installHostIntegration(target, {
            scope: command.scope,
            root,
            force: command.force,
          })
        : await uninstallHostIntegration(target, {
            scope: command.scope,
            root,
          });

    process.stdout.write(
      `${result.changed ? command.action : "unchanged"} ${target.displayName}\n` +
        `skill: ${result.skillDirectory}\n` +
        `mcp: ${result.mcpConfig}\n` +
        (result.backupPath ? `backup: ${result.backupPath}\n` : ""),
    );

    if (command.action === "install") {
      const restartGuidance =
        command.scope === "user"
          ? `Restart ${target.displayName}, then open any Git repository.`
          : `Restart ${target.displayName} in this repository.`;
      process.stdout.write(
        `\nOpenWiki is ready for ${target.displayName}.\n\n` +
          "Next:\n" +
          `  1. ${restartGuidance}\n` +
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
  const target = getHostTarget(command.host);
  await runOpenWikiMcp({
    host: command.host,
    producerActor: target?.producerActor ?? command.host,
  });
}
