import type { OpenWikiProvider } from "../../constants.js";
import { grokBuildAdapter } from "./grok-build.js";
import type { AgentCliAdapter } from "./types.js";

export function getAgentCliAdapter(
  provider: OpenWikiProvider,
): AgentCliAdapter {
  if (provider === "grok-build") {
    return grokBuildAdapter;
  }

  throw new Error(`No agent CLI adapter is registered for ${provider}.`);
}
