import {
  OPENROUTER_FALLBACK_MODEL_IDS,
  type OpenWikiProvider,
} from "../constants.js";

export function createModelRoute(
  provider: OpenWikiProvider,
  modelId: string,
): string[] {
  if (provider !== "openrouter") {
    return [modelId];
  }

  return Array.from(new Set([modelId, ...OPENROUTER_FALLBACK_MODEL_IDS]));
}
