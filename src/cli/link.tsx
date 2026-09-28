import path from "node:path";
import React from "react";
import { render } from "ink";
import { resolveRepositoryRoot } from "../integrations/core/repository-root.js";
import {
  clearActiveWikiWorkspace,
  discoverRepositoriesFromPath,
  listWikiWorkspaces,
  readWikiWorkspaceRegistry,
  resolveRepositoryFinderRoot,
  saveWikiWorkspaces,
  setActiveWikiWorkspace,
  workspaceDrafts,
  type DiscoveredRepository,
  type WikiWorkspaceDraft,
} from "../linking/wiki-workspaces.js";
import { getErrorMessage } from "../platform/diagnostics.js";
import type { CliCommand } from "./commands.js";
import { WikiWorkspaceManager } from "./components/wiki-workspace-manager.js";

/**
 * Runs the interactive named wiki-workspace manager.
 *
 * @param command - Parsed initial repository-finder location.
 */
export async function runLinkCommand(
  command: Extract<CliCommand, { kind: "link" }>,
): Promise<void> {
  try {
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
      throw new Error("openwiki link requires an interactive terminal.");
    }

    const baseDirectory = process.cwd();
    const finderRoot = await resolveRepositoryFinderRoot(
      command.directory,
      baseDirectory,
    );
    const registry = await readWikiWorkspaceRegistry();
    const result = await manageWikiWorkspaces(
      workspaceDrafts(registry),
      finderRoot,
      (finderPath, signal) =>
        discoverRepositoriesFromPath(finderPath, baseDirectory, signal),
    );
    if (!result) {
      process.exitCode = 0;
      return;
    }

    const saved = await saveWikiWorkspaces(result);
    process.stdout.write(
      `Saved ${saved.workspaces.length} wiki workspace${saved.workspaces.length === 1 ? "" : "s"}.\n`,
    );
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Runs persistent active-workspace inspection and mutation commands.
 *
 * @param command - Parsed workspace action.
 */
export async function runWorkspaceCommand(
  command: Extract<CliCommand, { kind: "workspace" }>,
): Promise<void> {
  try {
    const root = await resolveRepositoryRoot(path.resolve(process.cwd()));
    if (command.action === "use") {
      const workspace = await setActiveWikiWorkspace(root, command.workspace);
      process.stdout.write(`Active wiki workspace: ${workspace.name}\n`);
    } else if (command.action === "clear") {
      const cleared = await clearActiveWikiWorkspace(root);
      process.stdout.write(
        cleared
          ? "Cleared the active wiki workspace.\n"
          : "No active wiki workspace was set.\n",
      );
    } else {
      process.stdout.write(await describeCurrentWorkspace(root));
    }
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Renders the manager and resolves after Finish or Ctrl-C.
 *
 * @param initialWorkspaces - Complete initial workspace collection.
 * @param finderRoot - Canonical directory searched for repositories.
 * @param findRepositories - Creates the streaming repository scan.
 * @returns Final collection or `null` after cancellation.
 */
async function manageWikiWorkspaces(
  initialWorkspaces: readonly WikiWorkspaceDraft[],
  finderRoot: string,
  findRepositories: (
    finderPath: string,
    signal: AbortSignal,
  ) => AsyncIterable<DiscoveredRepository>,
): Promise<WikiWorkspaceDraft[] | null> {
  let result: WikiWorkspaceDraft[] | null = null;
  const instance = render(
    <WikiWorkspaceManager
      initialWorkspaces={initialWorkspaces}
      finderRoot={finderRoot}
      findRepositories={findRepositories}
      onSubmit={(workspaces) => {
        result = workspaces;
      }}
      onCancel={() => {
        result = null;
      }}
    />,
  );
  await instance.waitUntilExit();
  return result;
}

/**
 * Describes explicit, implicit, or ambiguous workspace state for one repository.
 *
 * @param root - Canonical current repository root.
 * @returns Human-readable current workspace status.
 */
async function describeCurrentWorkspace(root: string): Promise<string> {
  const listed = await listWikiWorkspaces(root);
  if (listed.activeWorkspace) {
    const active = listed.workspaces.find(
      (workspace) => workspace.id === listed.activeWorkspace,
    );
    if (active) return `Active wiki workspace: ${active.name}\n`;
  }
  if (listed.workspaces.length === 0) {
    return "This repository uses its own wiki.\n";
  }
  if (listed.workspaces.length === 1) {
    return `Wiki workspace: ${listed.workspaces[0].name} (automatic)\n`;
  }
  return [
    "No active wiki workspace is set.",
    "Available workspaces:",
    ...listed.workspaces.map((workspace) => `- ${workspace.name}`),
    "",
  ].join("\n");
}
