import type { Feedback } from "langsmith";

/**
 * One project entry in the config. One project = one source.
 */
export interface LangSmithProjectConfig {
  /**
   * LangSmith project (tracing session) name.
   */
  name: string;

  /**
   * Most-recent traces to pull for this project.
   *
   * @default 10
   */
  maxTraces?: number;
}

/**
 * User-editable configuration for the LangSmith connector.
 */
export interface LangSmithConfig {
  /**
   * Overrides the API host (EU workspaces: https://eu.api.smith.langchain.com).
   *
   * @default "https://api.smith.langchain.com"
   */
  apiBaseUrl?: string;

  /**
   * Whether the connector runs at all.
   *
   * @default false
   */
  enabled?: boolean;

  /**
   * Fetch feedback for the pulled traces.
   *
   * @default false
   */
  includeFeedback?: boolean;

  /**
   * Include raw run inputs/outputs in the trace dump. Code mode sets it true
   * because the dump is ephemeral (never committed).
   *
   * @default false
   */
  includePayloads?: boolean;

  /**
   * Maximum characters kept per free-text field before truncation.
   *
   * @default 2000
   */
  maxFieldChars?: number;

  /**
   * Default most-recent traces pulled per project; a project may override.
   *
   * @default 10
   */
  maxTraces?: number;

  /**
   * Projects to document; the connector skips when none are configured.
   *
   * @default []
   */
  projects?: LangSmithProjectConfig[];
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
   * Number of traces in the sample (the effective maxTraces, or fewer).
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

  /**
   * Feedback for the pulled traces (empty unless includeFeedback).
   */
  feedback: Feedback[];
}
