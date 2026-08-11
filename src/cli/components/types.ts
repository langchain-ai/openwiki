import type { OpenWikiCommand, OpenWikiRunResult } from "../../agent/types.js";
import type { CredentialDiagnostic } from "../../config/env.js";
import type { ReasoningEffort } from "../../config/reasoning.js";
import type { RunLogItem } from "../run-log/types.js";

/**
 * A finished agent run retained in the chat history.
 */
export interface CompletedRun {
  id: number;
  command: OpenWikiCommand;

  /**
   * @default undefined Credential diagnostics captured for the run, when the
   * debug credential dump was enabled.
   */
  credentialDiagnostics?: CredentialDiagnostic[];

  log: RunLogItem[];
  message: string | null;
  /** Reasoning effort selected when this run began, if the provider supports it. */
  reasoningEffort: ReasoningEffort | null;
  result: OpenWikiRunResult;
}
