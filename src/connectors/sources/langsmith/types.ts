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

  /**
   * Truncated inputs, present only when includePayloads is true.
   *
   * @default undefined
   */
  inputs?: string;

  /**
   * Truncated outputs, present only when includePayloads is true.
   *
   * @default undefined
   */
  outputs?: string;
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
   * Runs in the trace, root first then by start time.
   */
  runs: TraceRun[];
}

/**
 * A light summary over the pulled sample. Sample stats, not population stats.
 */
export interface SampleStats {
  /**
   * Number of traces in the sample (the trace budget, or fewer).
   */
  sampleSize: number;

  /**
   * Traces in the sample whose root run failed.
   */
  errorCount: number;

  /**
   * Median root-run latency in ms over the sample, or null when empty.
   */
  medianLatencyMs: number | null;

  /**
   * Sum of root-run total tokens across the sample.
   */
  totalTokens: number;
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
