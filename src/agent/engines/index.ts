import type { OpenWikiProvider } from "../../constants.js";
import { createAntigravityAdapter } from "./antigravity.js";
import { grokBuildAdapter } from "./grok-build.js";
import type { AgentCliAdapter } from "./types.js";

export function getAgentCliAdapter(
  provider: OpenWikiProvider,
): AgentCliAdapter {
  if (provider === "grok-build") {
    return grokBuildAdapter;
  }

  if (provider === "antigravity") {
    // Fresh instance per run so per-run log paths cannot clash.
    return createAntigravityAdapter();
  }

  throw new Error(`No agent CLI adapter is registered for ${provider}.`);
}
