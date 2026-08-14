import type { OpenWikiProvider } from "./config/constants.js";

export type ModelAvailability =
  | { status: "available" }
  | { status: "unavailable"; reason: string }
  | { status: "unknown"; reason?: string };

interface ModelAvailabilityCheck {
  apiKey?: string;
  baseUrl?: string;
  baseUrlIsCustom?: boolean;
  modelId: string;
  provider: OpenWikiProvider;
}

type ModelListResponse = {
  data?: Array<{ id?: unknown }>;
};

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

/**
 * Wall-clock cap on the catalogue lookup. This runs before inference on an
 * endpoint the user controls, so an unresponsive host must not stall the run:
 * the abort surfaces as `unknown` and inference proceeds.
 */
const AVAILABILITY_LOOKUP_TIMEOUT_MS = 5_000;

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
    const baseUrl = check.baseUrl;

    if (!check.baseUrlIsCustom || !baseUrl) {
      return {
        status: "unknown",
        reason: "The NVIDIA hosted endpoint is not validated.",
      };
    }

    return checkNvidiaNimModelAvailability(check, baseUrl, fetchImpl);
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
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<ModelAvailability> {
  let endpoint: string;

  try {
    endpoint = resolveModelListEndpoint(baseUrl);
  } catch {
    return {
      status: "unknown",
      reason: "The configured base URL could not be resolved to a catalogue.",
    };
  }

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
      signal: AbortSignal.timeout(AVAILABILITY_LOOKUP_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        status: "unknown",
        reason: `Model availability lookup returned HTTP ${response.status}.`,
      };
    }

    const body = (await response.json()) as ModelListResponse;
    if (!Array.isArray(body.data)) {
      return {
        status: "unknown",
        reason: "Model availability lookup returned an unexpected response.",
      };
    }

    if (body.data.length === 0) {
      // A gateway that hides its catalogue from a key without list scope still
      // serves inference, so an empty listing is no evidence of unavailability.
      return {
        status: "unknown",
        reason: "Model availability lookup returned an empty catalogue.",
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

/**
 * Appends `/models` to the API root's path. Building the URL from `pathname`
 * rather than resolving a relative reference keeps a base URL that carries a
 * query string or fragment from losing its last path segment.
 */
function resolveModelListEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl.trim());

  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/models`;
  url.hash = "";

  return url.toString();
}
