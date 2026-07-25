/**
 * One project entry in the config. One project = one source.
 */
export interface LangSmithProjectConfig {
  /**
   * LangSmith project (tracing session) name.
   */
  name: string;
}

/**
 * Why a trace was pulled. The sample is anomaly-weighted, not random: errored
 * roots and latency outliers are over-represented so the agent sees what code
 * review cannot, and baseline runs give the normal-operation reference.
 */
export type TraceBucket = "error" | "outlier" | "baseline";

/**
 * One compacted run within a trace tree.
 */
export interface TraceRun {
  /**
   * Run UUID.
   */
  id: string;

  /**
   * Parent run UUID; absent for the trace root.
   *
   * @default undefined
   */
  parentRunId?: string;

  /**
   * Run type: chain, llm, tool, retriever, and so on.
   *
   * @default undefined
   */
  runType?: string;

  /**
   * Human-readable run name (for a tool run, the tool name).
   *
   * @default undefined
   */
  name?: string;

  /**
   * Run status string from the SDK.
   *
   * @default undefined
   */
  status?: string;

  /**
   * ISO start timestamp, when known.
   *
   * @default undefined
   */
  startTime?: string;

  /**
   * ISO end timestamp, when known.
   *
   * @default undefined
   */
  endTime?: string;

  /**
   * Wall-clock latency in milliseconds, when computable.
   *
   * @default undefined
   */
  latencyMs?: number;

  /**
   * Total token count, when reported.
   *
   * @default undefined
   */
  totalTokens?: number;

  /**
   * Truncated, secret-safe error text, when the run failed.
   *
   * @default undefined
   */
  error?: string;
}

/**
 * One full trace: the ordered tree of runs plus a deep link.
 */
export interface Trace {
  /**
   * Trace UUID (the root run's trace id).
   */
  traceId: string;

  /**
   * Deep link to the trace in the LangSmith UI.
   */
  traceUrl: string;

  /**
   * Whether the trace's root run failed.
   */
  isError: boolean;

  /**
   * Which sampling bucket selected this trace (error / latency outlier / recent
   * baseline). Lets the agent read the sample as intentionally biased.
   */
  bucket: TraceBucket;

  /**
   * Runs in the trace, root first then by start time.
   */
  runs: TraceRun[];
}

/**
 * A light summary over the pulled sample. The sample is anomaly-weighted, so
 * bucket counts are sample composition, NOT fleet rates; medians are computed
 * over baseline runs only so they reflect normal operation.
 */
export interface SampleStats {
  /**
   * Number of traces in the sample (the trace budget, or fewer).
   */
  sampleSize: number;

  /**
   * How many pulled traces came from each bucket. Composition of a deliberately
   * biased sample, not an error rate.
   */
  bucketCounts: Record<TraceBucket, number>;

  /**
   * Median root-run latency in ms over the BASELINE bucket only, or null when
   * there are no baseline runs. Excludes error/outlier buckets so the figure is
   * a normal-operation reference, not skewed by the over-sampled tail.
   */
  baselineMedianLatencyMs: number | null;

  /**
   * Median root-run total tokens over the BASELINE bucket only, or null when
   * there are no baseline runs.
   */
  baselineMedianTokens: number | null;
}

/**
 * Everything pulled for one project in one ingestion run.
 */
export interface ProjectPullResult {
  /**
   * Configured project name.
   */
  project: string;

  /**
   * API host the project was pulled from, so the wiki can attribute a project to
   * its region/workspace.
   */
  apiBaseUrl: string;

  /**
   * Resolved project UUID.
   */
  projectId: string;

  /**
   * Sample summary over the pulled traces.
   */
  stats: SampleStats;

  /**
   * The pulled full traces (most-recent first).
   */
  traces: Trace[];
}
