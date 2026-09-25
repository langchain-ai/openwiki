import type { BenchmarkDifficulty } from "../core/types.js";

/** One current claim displayed by verbose checkpoint output. */
export interface ProgressClaim {
  location: string;
  assertion: string;
}

/**
 * Observable lifecycle events emitted by a benchmark run.
 */
export type BenchmarkProgressEvent =
  | {
      type: "run-start";
      benchmarkName: string;
      difficulty: BenchmarkDifficulty;
      totalCheckpoints: number;
      provider: string;
      systemModelId?: string;
      evaluatorModelId?: string;
      evaluationOnly?: boolean;
    }
  | { type: "replay-ready"; saved?: boolean }
  | {
      type: "checkpoint-start";
      checkpointId: string;
      checkpointIndex: number;
      totalCheckpoints: number;
      commit: string;
      label?: string;
      command: "init" | "update";
      evaluationOnly?: boolean;
    }
  | {
      type: "system-complete";
      checkpointId: string;
      command: "init" | "update";
      durationMs: number;
      skipped: boolean;
    }
  | {
      type: "artifact-captured";
      checkpointId: string;
      documentCount: number;
      loaded?: boolean;
    }
  | {
      type: "evaluation-start";
      checkpointId: string;
      obsoleteFactCount: number;
    }
  | {
      type: "claim-extraction-progress";
      checkpointId: string;
      completed: number;
      total: number;
      obsoleteFactCount: number;
    }
  | {
      type: "claim-evaluation-progress";
      checkpointId: string;
      claimCount: number;
      completed: number;
      total: number;
      obsoleteFactCount: number;
    }
  | {
      type: "checkpoint-complete";
      checkpointId: string;
      claimCount: number;
      supportedCount: number;
      staleCount: number;
      hallucinatedCount: number;
      unverifiedCount: number;
      supportedRate: number;
      stalenessRate: number;
      hallucinationRate: number;
      unverifiedRate: number;
      forgottenCount: number;
      obsoleteFactCount: number;
      evaluationCompleteness: number;
      indeterminateCount: number;
      evaluationItemCount: number;
      staleClaims: ProgressClaim[];
      hallucinatedClaims: ProgressClaim[];
    }
  | { type: "run-complete" }
  | { type: "run-failed"; message: string };

/**
 * Receives one benchmark lifecycle event synchronously.
 */
export type BenchmarkProgressReporter = (event: BenchmarkProgressEvent) => void;
