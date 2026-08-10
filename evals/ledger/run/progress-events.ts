/**
 * Observable lifecycle events emitted by a benchmark run.
 */
export type BenchmarkProgressEvent =
  | {
      type: "run-start";
      benchmarkName: string;
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
      activeFactCount: number;
      obsoleteFactCount: number;
    }
  | {
      type: "checkpoint-complete";
      checkpointId: string;
      coverageScore: number;
      precisionScore: number | null;
      hallucinationRate: number | null;
      stalenessRate: number | null;
      unverifiedRate: number;
      forgottenCount: number;
      obsoleteFactCount: number;
      evaluationCompleteness: number;
      indeterminateCount: number;
      evaluationItemCount: number;
      materialClaimCount: number;
      supportedCount: number;
      inventedCount: number;
      staleCount: number;
      unverifiedCount: number;
    }
  | {
      type: "run-complete";
      ledgerScore: number | null;
      quality: number | null;
      traceCoverage: number;
      tracePrecision: number | null;
      traceHallucinationRate: number | null;
      traceStalenessRate: number | null;
      traceUnverifiedRate: number;
      maintenance?: number;
      newKnowledgeDiscovery?: number;
      changedKnowledgeCorrection?: number;
      completeForgetting?: number;
      stableRetention?: number;
      evaluationCompleteness: number;
      materialClaimCount: number;
      supportedCount: number;
      inventedCount: number;
      staleCount: number;
      unverifiedCount: number;
    }
  | { type: "run-failed"; message: string };

/**
 * Receives one benchmark lifecycle event synchronously.
 */
export type BenchmarkProgressReporter = (event: BenchmarkProgressEvent) => void;
