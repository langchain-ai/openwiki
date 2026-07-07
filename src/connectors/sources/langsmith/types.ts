import type { Feedback } from "langsmith";

/**
 * User-editable settings in ~/.openwiki/connectors/langsmith/config.json.
 */
export type LangSmithConfig = {
  /**
   * Base URL (host root) of the LangSmith API, passed to the SDK Client.
   */
  apiBaseUrl?: string;

  /**
   * Master switch. The connector reports "skipped" until this is true.
   */
  enabled?: boolean;

  /**
   * When true, recent feedback entries are fetched for each error run.
   */
  includeFeedback?: boolean;

  /**
   * Maximum failed root runs to fetch per project per run.
   */
  maxErrorRuns?: number;

  /**
   * Maximum characters kept from any free-text run field (inputs, outputs,
   * error).
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
};

/**
 * The truncated, citation-ready form of a run that is written to raw output.
 * Field names are camelCase to signal this is OpenWiki's shape, not the
 * API's.
 */
export type CompactRun = {
  /**
   * ISO timestamp when the run finished, if it has finished.
   */
  endTime?: string;

  /**
   * Truncated error message for failed runs.
   */
  error?: string;

  /**
   * Run UUID, kept so wiki claims can cite specific runs.
   */
  id: string;

  /**
   * Truncated, stringified run inputs.
   */
  inputs?: string;

  /**
   * Wall-clock duration in milliseconds, when both timestamps exist.
   */
  latencyMs?: number;

  /**
   * Human-readable run name.
   */
  name?: string;

  /**
   * Truncated, stringified run outputs.
   */
  outputs?: string;

  /**
   * ISO timestamp when the run started.
   */
  startTime?: string;

  /**
   * Lifecycle status, such as "success" or "error".
   */
  status?: string;

  /**
   * Total tokens consumed by the run, when tracked.
   */
  totalTokens?: number;

  /**
   * Link to the run in the LangSmith UI, for provenance in wiki citations.
   */
  traceUrl: string;
};

/**
 * Aggregates computed in code so the agent never does math over raw traces.
 */
export type ProjectStats = {
  /**
   * Number of failed runs within the recent-runs sample; the numerator of
   * errorRate. May be smaller than errorRuns.length, which is a separate,
   * dedicated sample of failures for detail.
   */
  errorCount: number;

  /**
   * errorCount / runCount, rounded to two decimals; 0 when no runs. Both terms
   * come from the recent-runs sample so the rate is internally consistent.
   */
  errorRate: number;

  /**
   * Median run latency in milliseconds, or null with no measurable runs.
   */
  latencyMsP50: number | null;

  /**
   * 95th-percentile run latency in milliseconds, or null.
   */
  latencyMsP95: number | null;

  /**
   * Number of recent root runs fetched in this window.
   */
  runCount: number;

  /**
   * Sum of total_tokens across recent runs.
   */
  totalTokens: number;
};

/**
 * Everything pulled for one configured project in one ingestion run.
 */
export type ProjectPullResult = {
  /**
   * Failed root runs, compacted and truncated.
   */
  errorRuns: CompactRun[];

  /**
   * Feedback entries attached to the error runs, when configured.
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
   * Recent root runs regardless of status, compacted and truncated.
   */
  recentRuns: CompactRun[];

  /**
   * Aggregate statistics computed over the fetched runs.
   */
  stats: ProjectStats;
};
