import type { OpenWikiProvider } from "../../constants.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { ibmBobAdapter } from "./ibm-bob.js";
import type { AgentCliAdapter } from "./types.js";

const adapters: Partial<Record<OpenWikiProvider, AgentCliAdapter>> = {
  "claude-code": claudeCodeAdapter,
  "ibm-bob": ibmBobAdapter,
};

export function getAgentCliAdapter(
  provider: OpenWikiProvider,
): AgentCliAdapter {
  const adapter = adapters[provider];

  if (!adapter) {
    throw new Error(`No agent CLI adapter is registered for ${provider}.`);
  }

  return adapter;
}
