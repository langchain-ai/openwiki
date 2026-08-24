import type {
  OpenWikiCommand,
  RepositoryGenerationProgressEvent,
} from "../../agent/types.js";
import type { RunLogItem, RunRepositoryProgressLogItem } from "./types.js";

/**
 * Finds the single current repository lifecycle item in a bounded run log.
 *
 * @param log - Current bounded run log.
 * @returns Current repository progress, when this is a native repository run.
 */
export function findRepositoryProgress(
  log: readonly RunLogItem[],
): RunRepositoryProgressLogItem | undefined {
  return log.find(
    (item): item is RunRepositoryProgressLogItem =>
      item.type === "repository_progress",
  );
}

/**
 * Formats structured repository progress for the interactive run stage.
 *
 * @param progress - Current lifecycle event or retained log item.
 * @param command - Repository command represented by the run.
 * @returns Concise human-readable lifecycle label.
 */
export function formatRepositoryProgress(
  progress: RepositoryGenerationProgressEvent | RunRepositoryProgressLogItem,
  command: OpenWikiCommand,
): string {
  switch (progress.stage) {
    case "planning":
      return progress.resumed
        ? "Resuming repository wiki planning"
        : "Planning repository wiki";
    case "replanning":
      return "Repository changed during generation · rebuilding the plan";
    case "generating":
      return formatPageProgress(progress);
    case "finalizing":
      return "Finalizing repository wiki";
    case "noop":
      return command === "update"
        ? "Repository wiki is already current"
        : "Repository wiki needs no changes";
  }
}

/**
 * Formats one structured event as a print-mode progress line.
 *
 * @param event - Repository lifecycle event emitted by the native runner.
 * @param command - Repository command represented by the run.
 * @returns One newline-terminated progress line.
 */
export function formatRepositoryPrintProgress(
  event: RepositoryGenerationProgressEvent,
  command: OpenWikiCommand,
): string {
  return `${formatRepositoryProgress(event, command)}\n`;
}

/**
 * Formats current-page progress without inventing missing queue data.
 *
 * @param progress - Generating-stage progress payload.
 * @returns Page position and canonical path when available.
 */
function formatPageProgress(
  progress: RepositoryGenerationProgressEvent | RunRepositoryProgressLogItem,
): string {
  const page = progress.page ?? "repository page";
  if (progress.pageIndex && progress.pageCount !== undefined) {
    return `Documenting page ${progress.pageIndex} of ${progress.pageCount} · ${page}`;
  }
  return `Documenting ${page}`;
}
