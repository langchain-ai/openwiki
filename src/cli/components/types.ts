import type { OpenWikiCommand, OpenWikiRunResult } from "../../agent/types.js";
import type { CredentialDiagnostic } from "../../config/env.js";
import type { ReasoningEffort } from "../../config/reasoning.js";
import type { RunLogItem } from "../run-log/types.js";

/**
 * A finished agent run retained in the chat history.
 */
export interface CompletedRun {
  /**
   * Monotonic identity used as the React history key.
   */
  id: number;

  /**
   * OpenWiki operation that produced the run.
   */
  command: OpenWikiCommand;

  /**
   * Credential diagnostics captured when debug output was enabled.
   *
   * @default undefined - no credential diagnostics were captured.
   */
  credentialDiagnostics?: CredentialDiagnostic[];

  /**
   * Total elapsed wall-clock time for the run.
   */
  durationMs: number;

  /**
   * Bounded progress and completion model retained for scrollback.
   */
  log: RunLogItem[];

  /**
   * User prompt associated with the run.
   *
   * @default null - the run had no explicit user prompt.
   */
  message: string | null;

  /**
   * Reasoning effort selected when this run began, if the provider supports it.
   *
   * @default null - the model does not expose configurable reasoning effort.
   */
  reasoningEffort: ReasoningEffort | null;

  /**
   * Settled agent result, including the command and resolved model.
   */
  result: OpenWikiRunResult;
}
