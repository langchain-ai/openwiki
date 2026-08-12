import type { EvidenceCorpus } from "../core/types.js";
import { collectGitEvidence } from "./git-evidence.js";

/**
 * Converts one materialized source checkpoint into normalized evidence without
 * depending on the knowledge-artifact format or evaluator implementation.
 */
export interface SourceEvidenceAdapter {
  /**
   * Stable adapter name used in diagnostics and future benchmark configuration.
   */
  readonly name: string;

  /**
   * Collect immutable evidence from the active source checkpoint.
   *
   * @param checkpointId - Active benchmark checkpoint.
   * @param sourceRoot - Materialized source root supplied by the replay adapter.
   *
   * @returns Normalized evidence corpus.
   */
  collectEvidence(
    checkpointId: string,
    sourceRoot: string,
  ): Promise<EvidenceCorpus>;
}

/**
 * First source-evidence adapter, backed by tracked files in a Git worktree.
 */
export class GitSourceEvidenceAdapter implements SourceEvidenceAdapter {
  readonly name = "git-tracked-files";

  /**
   * Collect tracked text files from the active Git worktree.
   *
   * @param checkpointId - Active benchmark checkpoint.
   * @param sourceRoot - Checked-out Git worktree.
   *
   * @returns Normalized Git evidence corpus.
   */
  collectEvidence(
    checkpointId: string,
    sourceRoot: string,
  ): Promise<EvidenceCorpus> {
    return collectGitEvidence(checkpointId, sourceRoot);
  }
}
