import type { OpenWikiCommand, OpenWikiRunEvent } from "../types.js";

export type EngineRunSpec = {
  command: OpenWikiCommand;
  cwd: string;
  /** "default" means the vendor CLI's own default model (no model flag). */
  modelId: string;
  /** Fully assembled user prompt, delivered on stdin. */
  prompt: string;
  /** Appended to (not replacing) the vendor agent's own system prompt. */
  systemPrompt: string;
  /** Vendor session id to resume for interactive follow-ups. */
  resumeSessionId?: string;
};

export type AgentCliEvent =
  | { type: "openwiki"; event: OpenWikiRunEvent }
  | { type: "session"; sessionId: string }
  | { type: "result"; ok: boolean; errorMessage?: string };

export type AgentCliInstallStatus = {
  found: boolean;
  version?: string;
};

export type AgentCliAdapter = {
  id: "claude-code";
  detectInstall(binary: string): Promise<AgentCliInstallStatus>;
  buildArgs(spec: EngineRunSpec): string[];
  /** Parses one NDJSON line of vendor output; unknown lines return []. */
  parseEvent(line: unknown): AgentCliEvent[];
};
