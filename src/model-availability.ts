import type { OpenWikiProvider } from "./constants.js";

export type ModelAvailability =
  | { status: "available" }
  | { status: "unavailable"; reason: string }
  | { status: "unknown"; reason?: string };

type ModelAvailabilityCheck = {
  apiKey?: string;
  baseUrl?: string;
  baseUrlIsCustom?: boolean;
  modelId: string;
  provider: OpenWikiProvider;
};

type OpenAIModelListResponse = {
  data?: Array<{ id?: unknown }>;
};

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

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
    if (check.baseUrl !== undefined) {
      return {
        status: "unknown",
        reason: "Custom OpenAI-compatible endpoints are not validated.",
      };
    }

    return checkOpenAIModelAvailability(check, fetchImpl);
  }

  if (check.provider === "nvidia") {
    if (!check.baseUrlIsCustom || !check.baseUrl) {
      return {
        status: "unknown",
        reason: "The NVIDIA hosted endpoint is not validated.",
      };
    }

    return checkNvidiaNimModelAvailability(check, fetchImpl);
  }

  return {
    status: "unknown",
    reason: "No availability adapter is configured.",
  };
}

async function checkOpenAIModelAvailability(
  check: ModelAvailabilityCheck,
  fetchImpl: typeof fetch,
): Promise<ModelAvailability> {
  return checkModelListAvailability({
    apiKey: check.apiKey,
    endpoint: `${OPENAI_API_BASE_URL}/models`,
    fetchImpl,
    modelId: check.modelId,
    providerLabel: "OpenAI",
  });
}

async function checkNvidiaNimModelAvailability(
  check: ModelAvailabilityCheck,
  fetchImpl: typeof fetch,
): Promise<ModelAvailability> {
  const endpoint = new URL(
    "models",
    ensureTrailingSlash(check.baseUrl!),
  ).toString();

  return checkModelListAvailability({
    apiKey: check.apiKey,
    endpoint,
    fetchImpl,
    modelId: check.modelId,
    providerLabel: "NVIDIA NIM",
  });
}

async function checkModelListAvailability({
  apiKey,
  endpoint,
  fetchImpl,
  modelId,
  providerLabel,
}: {
  apiKey?: string;
  endpoint: string;
  fetchImpl: typeof fetch;
  modelId: string;
  providerLabel: string;
}): Promise<ModelAvailability> {
  if (!apiKey) {
    return {
      status: "unknown",
      reason: "No API key is available for validation.",
    };
  }

  try {
    const response = await fetchImpl(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
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

    if (body.data.some((model) => model.id === modelId)) {
      return { status: "available" };
    }

    return {
      status: "unavailable",
      reason: `The selected model is not available through this ${providerLabel} endpoint.`,
    };
  } catch {
    return {
      status: "unknown",
      reason: "Model availability lookup could not be completed.",
    };
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
