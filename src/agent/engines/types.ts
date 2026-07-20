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

export type AgentCliAdapter = {
  id: string;
  detectInstall(binary: string): Promise<AgentCliInstallStatus>;
  /**
   * Builds CLI args. The runner writes `spec.prompt` to a temp file and passes
   * its path as `promptFilePath` so long system+user prompts do not hit ARG_MAX.
   */
  buildArgs(spec: EngineRunSpec, promptFilePath: string): string[];
  createParser(): AgentCliStreamParser;
};
