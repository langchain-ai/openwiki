import type { Feedback } from "langsmith";

/**
 * User-editable configuration for the LangSmith connector.
 */
export interface LangSmithConfig {
  /**
   * Overrides the API host (EU workspaces: https://eu.api.smith.langchain.com).
   */
  apiBaseUrl?: string;

  /**
   * Whether the connector runs at all.
   */
  enabled?: boolean;

  /**
   * Fetch feedback for error runs.
   */
  includeFeedback?: boolean;

  /**
   * Include raw run inputs/outputs in the raw dump. Defaults to false; keep it
   * false for code mode so payloads never reach the committed wiki.
   */
  includePayloads?: boolean;

  /**
   * Maximum failed root runs to fetch per project per run.
   */
  maxErrorRuns?: number;

  /**
   * Maximum characters kept per free-text field before truncation.
   */
  maxFieldChars?: number;

  /**
   * Maximum recent root runs to fetch per project per run.
   */
  maxRootRuns?: number;

  /**
   * LangSmith project (tracing session) names to monitor.
   */
  projects?: string[];
}

/**
 * A run trimmed to the citation-ready shape written to the raw dump.
 */
export interface CompactRun {
  /**
   * ISO end timestamp, when known.
   */
  endTime?: string;

  /**
   * Truncated, secret-safe error text, when the run failed.
   */
  error?: string;

  /**
   * Run UUID.
   */
  id: string;

  /**
   * Truncated inputs, present only when includePayloads is true.
   */
  inputs?: string;

  /**
   * Wall-clock latency in milliseconds, when computable.
   */
  latencyMs?: number;

  /**
   * Human-readable run name.
   */
  name?: string;

  /**
   * Truncated outputs, present only when includePayloads is true.
   */
  outputs?: string;

  /**
   * ISO start timestamp, when known.
   */
  startTime?: string;

  /**
   * Run status string from the SDK.
   */
  status?: string;

  /**
   * Total token count, when reported.
   */
  totalTokens?: number;

  /**
   * Deep link to the run in the LangSmith UI.
   */
  traceUrl: string;
}

/**
 * Per-project aggregates over the recent-runs sample.
 */
export interface ProjectStats {
  /**
   * Runs in the sample that failed.
   */
  errorCount: number;

  /**
   * errorCount / runCount, rounded, or 0 for an empty sample.
   */
  errorRate: number;

  /**
   * Median latency in ms, or null for an empty sample.
   */
  latencyMsP50: number | null;

  /**
   * 95th-percentile latency in ms, or null for an empty sample.
   */
  latencyMsP95: number | null;

  /**
   * Size of the recent-runs sample.
   */
  runCount: number;

  /**
   * Sum of total tokens across the sample.
   */
  totalTokens: number;
}

/**
 * Everything pulled for one configured project in one ingestion run.
 */
export interface ProjectPullResult {
  /**
   * Failed root runs, compacted.
   */
  errorRuns: CompactRun[];

  /**
   * Feedback entries for the error runs (empty unless includeFeedback).
   */
  feedback: Feedback[];

  /**
   * Configured project name.
   */
  project: string;

  /**
   * Resolved project UUID.
   */
  projectId: string;

  /**
   * Recent root runs, compacted.
   */
  recentRuns: CompactRun[];

  /**
   * Aggregates over recentRuns.
   */
  stats: ProjectStats;
}
