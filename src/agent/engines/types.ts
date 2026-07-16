import type { OpenWikiCommand, OpenWikiRunEvent } from "../types.js";
import type { AgentCliWriteBoundary } from "./write-boundary.js";

export type EngineRunSpec = {
  command: OpenWikiCommand;
  cwd: string;
  /** Fully assembled prompt, delivered via a temporary prompt file. */
  prompt: string;
  /** Vendor session id to resume for interactive follow-ups. */
  resumeSessionId?: string;
  modelId: string;
  /**
   * Post-run filesystem write policy. Defaults to `none`.
   * Repository init/update sets `docs-only` so the runner rejects runs that
   * touch paths outside `openwiki/` (plus root AGENTS.md / CLAUDE.md).
   */
  writeBoundary?: AgentCliWriteBoundary;
};

export type AgentCliEvent =
  | { type: "openwiki"; event: OpenWikiRunEvent }
  | { type: "session"; sessionId: string }
  | { type: "result"; ok: boolean; errorMessage?: string };

export type AgentCliInstallStatus = {
  found: boolean;
  version?: string;
};

/**
 * Stateful stream parser. Holds buffer across NDJSON lines so partial text
 * tokens can be coalesced before OpenWiki surfaces them.
 */
export type AgentCliStreamParser = {
  parse(line: unknown): AgentCliEvent[];
  /** Flush any remaining buffered output once the process exits. */
  flush(): AgentCliEvent[];
};

/**
 * How the runner interprets adapter stdout.
 * - `ndjson` (default): one JSON object per line (Grok Build streaming-json).
 * - `text`: plain assistant text lines (Antigravity print mode).
 */
export type AgentCliStreamFormat = "ndjson" | "text";

export type AgentCliExitInfo = {
  exitCode: number | null;
  stderrTail: string;
};

export type AgentCliAdapter = {
  id: string;
  /**
   * How stdout is interpreted. Defaults to {@link AgentCliStreamFormat} `ndjson`.
   */
  streamFormat?: AgentCliStreamFormat;
  detectInstall(binary: string): Promise<AgentCliInstallStatus>;
  /**
   * Builds CLI args. The runner writes `spec.prompt` to a temp file and passes
   * its path as `promptFilePath` so long system+user prompts do not hit ARG_MAX
   * (adapters that only accept an inline prompt may still read that file).
   */
  buildArgs(spec: EngineRunSpec, promptFilePath: string): string[];
  createParser(): AgentCliStreamParser;
  /**
   * Optional post-process after the child exits. Used by plain-text CLIs to
   * recover session ids from log files, recover empty stdout, and synthesize a
   * terminal {@link AgentCliEvent} `result` when the stream has no NDJSON end.
   */
  afterExit?(info: AgentCliExitInfo): AgentCliEvent[] | Promise<AgentCliEvent[]>;
  /** Optional cleanup for per-run temp files (log files, etc.). */
  cleanup?(): void | Promise<void>;
};
