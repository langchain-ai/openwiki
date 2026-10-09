import type { OpenWikiProvider } from "./config/constants.js";

export type ModelAvailability =
  | { status: "available" }
  | { status: "unavailable"; reason: string }
  | { status: "unknown"; reason?: string };

interface ModelAvailabilityCheck {
  apiKey?: string;
  baseUrl?: string;
  modelId: string;
  provider: OpenWikiProvider;
}

type OpenAIModelListResponse = {
  data?: Array<{ id?: unknown }>;
};

type CopilotModelListResponse = {
  data?: Array<{
    id?: unknown;
    capabilities?: { type?: unknown };
    model_picker_enabled?: unknown;
    policy?: { state?: unknown };
  }>;
};

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const COPILOT_API_BASE_URL = "https://api.githubcopilot.com";

/**
 * Checks whether a selected model is exposed to the configured provider
 * credential. `unknown` deliberately preserves the existing inference path:
 * a catalogue lookup failure is not proof that a model cannot be invoked.
 */
export async function getSelectedModelAvailability(
  check: ModelAvailabilityCheck,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ModelAvailability> {
  if (check.provider === "openai") {
    return getOpenAIModelAvailability(check, fetchImpl);
  }

  if (check.provider === "copilot") {
    return getCopilotModelAvailability(check, fetchImpl);
  }

  return {
    status: "unknown",
    reason: "No availability adapter is configured.",
  };
}

async function getOpenAIModelAvailability(
  check: ModelAvailabilityCheck,
  fetchImpl: typeof fetch,
): Promise<ModelAvailability> {
  if (check.baseUrl !== undefined) {
    return {
      status: "unknown",
      reason: "Custom OpenAI-compatible endpoints are not validated.",
    };
  }

  if (!check.apiKey) {
    return {
      status: "unknown",
      reason: "No API key is available for validation.",
    };
  }

  try {
    const response = await fetchImpl(`${OPENAI_API_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${check.apiKey}` },
    });

    if (!response.ok) {
      return {
        status: "unknown",
        reason: `Model availability lookup returned HTTP ${response.status}.`,
      };
    }

    const body = (await response.json()) as OpenAIModelListResponse;
    if (!Array.isArray(body.data)) {
      return {
        status: "unknown",
        reason: "Model availability lookup returned an unexpected response.",
      };
    }

    if (body.data.some((model) => model.id === check.modelId)) {
      return { status: "available" };
    }

    return {
      status: "unavailable",
      reason: "The selected model is not available to this OpenAI API key.",
    };
  } catch {
    return {
      status: "unknown",
      reason: "Model availability lookup could not be completed.",
    };
  }
}

async function getCopilotModelAvailability(
  check: ModelAvailabilityCheck,
  fetchImpl: typeof fetch,
): Promise<ModelAvailability> {
  if (!check.apiKey) {
    return {
      status: "unknown",
      reason: "No API key is available for validation.",
    };
  }

  const baseUrl = check.baseUrl ?? COPILOT_API_BASE_URL;

  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/u, "")}/models`, {
      headers: { Authorization: `Bearer ${check.apiKey}` },
    });

    if (!response.ok) {
      return {
        status: "unknown",
        reason: `Model availability lookup returned HTTP ${response.status}.`,
      };
    }

    const body = (await response.json()) as CopilotModelListResponse;
    if (!Array.isArray(body.data)) {
      return {
        status: "unknown",
        reason: "Model availability lookup returned an unexpected response.",
      };
    }

    const model = body.data.find((candidate) => candidate.id === check.modelId);
    if (!model || model.capabilities?.type !== "chat") {
      return {
        status: "unavailable",
        reason:
          "The selected model is not available to this GitHub Copilot account.",
      };
    }

    if (
      model.policy?.state === "enabled" ||
      (model.policy?.state === undefined && model.model_picker_enabled === true)
    ) {
      return { status: "available" };
    }

    if (model.policy?.state === "disabled") {
      return {
        status: "unavailable",
        reason:
          "The selected model is not available to this GitHub Copilot account.",
      };
    }

    return {
      status: "unknown",
      reason: "The Copilot Models API did not report an eligibility state.",
    };
  } catch {
    return {
      status: "unknown",
      reason: "Model availability lookup could not be completed.",
    };
  }
}
