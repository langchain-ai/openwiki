import {
  createFilesystemMiddleware,
  type AnyBackendProtocol,
  type FsToolName,
  type SubAgent,
} from "deepagents";
import { resolveSkeletonCriticSubagents } from "./skeleton-critic.js";
import type { OpenWikiCommand, OpenWikiOutputMode } from "./types.js";
import { resolveWikiQaSubagents } from "./wiki-qa-subagents.js";

/**
 * Built-in filesystem tools exposed to repository review subagents.
 *
 * Reviewers need broad source discovery, but never author repository content and
 * never execute shell commands. Excluding the mutating and execution tools makes
 * that boundary effective at the tool surface; path permissions cannot constrain a
 * shell-capable backend because a command can access paths outside the file tools.
 */
export const REVIEWER_FILESYSTEM_TOOLS = [
  "read_file",
  "ls",
  "glob",
  "grep",
] as const satisfies readonly FsToolName[];

/**
 * Resolves the init-only repository reviewers with a read/search-only filesystem
 * middleware. The custom middleware has the same name as DeepAgents' default
 * filesystem middleware, so DeepAgents replaces the default for these subagents
 * instead of exposing write, edit, or execute alongside it.
 */
export function resolveRepositoryReviewSubagents(
  command: OpenWikiCommand,
  outputMode: OpenWikiOutputMode,
  backend: AnyBackendProtocol,
): SubAgent[] {
  const reviewers = [
    ...resolveSkeletonCriticSubagents(command, outputMode),
    ...resolveWikiQaSubagents(command, outputMode),
  ];

  if (reviewers.length === 0) {
    return [];
  }

  return reviewers.map((reviewer) => ({
    ...reviewer,
    middleware: [
      ...(reviewer.middleware ?? []),
      createFilesystemMiddleware({
        backend,
        tools: REVIEWER_FILESYSTEM_TOOLS,
      }),
    ],
  }));
}
