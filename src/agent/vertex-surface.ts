import { GoogleAuth } from "google-auth-library";
import { ANTHROPIC_API_KEY_ENV_KEY } from "../constants.js";

/**
 * A Vertex AI Model Garden model can be served over one of several distinct API
 * surfaces, each requiring a different client. The surface is a function of the
 * model ID (its family), not of the provider — a single Google project + region
 * + ADC credential can reach all of them.
 *
 * - `gemini`: Google's own models (Gemini and Gemma) over the native
 *   `generateContent` surface, spoken by `ChatGoogle`.
 * - `anthropic`: Claude over `rawPredict`/`streamRawPredict`, Anthropic's own
 *   wire protocol, reached via the Anthropic Vertex SDK.
 * - `openai-maas`: partner/open-weight models (Llama, Mistral, DeepSeek, Qwen,
 *   …) over the OpenAI-compatible `/endpoints/openapi/chat/completions` surface.
 */
export type VertexSurface = "anthropic" | "gemini" | "openai-maas";

// These two patterns are the maintenance point when Vertex adds publishers:
// extend the relevant alternation. `meta`/`llama` are both listed intentionally
// so IDs are tolerated whether given as the publisher (`meta/…`) or the model
// family (`llama-…`). `codellama` is listed separately because the `(^|\/)`
// boundary means the `llama` token would not match the bare `codellama-…` form.
const ANTHROPIC_MODEL_PATTERN = /(^|\/)(anthropic|claude)/u;
const OPENAI_MAAS_MODEL_PATTERN =
  /(^|\/)(ai21|codellama|codestral|deepseek|jamba|llama|meta|mistral|qwen)/u;

/**
 * Classifies a Vertex model ID into the API surface used to serve it. Tolerant
 * of both bare IDs (`claude-sonnet-4-5@20250929`, `meta/llama-3.3-70b-instruct-maas`)
 * and fully publisher-pathed IDs (`publishers/anthropic/models/claude-…`).
 * Defaults to `gemini`, which also covers Gemma.
 */
export function resolveVertexSurface(modelId: string): VertexSurface {
  const id = modelId.toLowerCase();

  if (ANTHROPIC_MODEL_PATTERN.test(id)) {
    return "anthropic";
  }

  if (OPENAI_MAAS_MODEL_PATTERN.test(id)) {
    return "openai-maas";
  }

  return "gemini";
}

/**
 * Reduces a fully-qualified publisher path to its bare model ID, e.g.
 * `publishers/anthropic/models/claude-sonnet-4-5` -> `claude-sonnet-4-5`. The
 * Anthropic Vertex SDK expects the bare model ID. Bare inputs pass through
 * unchanged.
 */
export function stripPublisherPath(modelId: string): string {
  const segments = modelId.split("/");

  return segments[segments.length - 1] ?? modelId;
}

/**
 * Normalizes a Model Garden ID to the `publisher/model` form the Vertex
 * OpenAI-compatible endpoint expects, e.g.
 * `publishers/meta/models/llama-3.3-70b` -> `meta/llama-3.3-70b`. IDs already in
 * `publisher/model` or bare form pass through unchanged.
 */
export function toVertexPublisherModel(modelId: string): string {
  const match = /^publishers\/([^/]+)\/models\/(.+)$/u.exec(modelId);
  return match ? `${match[1]}/${match[2]}` : modelId;
}

/**
 * Builds the Vertex AI OpenAI-compatible base URL for a project and region. The
 * OpenAI SDK appends `/chat/completions` to this.
 *
 * The `global` location is served from the unprefixed `aiplatform.googleapis.com`
 * host (regional locations use a `${location}-` prefix). The path segment stays
 * `locations/global`. This mirrors how the Anthropic Vertex SDK and ChatGoogle
 * resolve the global endpoint; interpolating `global-aiplatform.googleapis.com`
 * would hit a non-existent host.
 */
export function vertexOpenAIBaseUrl(
  projectId: string,
  location: string,
): string {
  const host =
    location === "global"
      ? "aiplatform.googleapis.com"
      : `${location}-aiplatform.googleapis.com`;

  return `https://${host}/v1/projects/${projectId}/locations/${location}/endpoints/openapi`;
}

const ANTHROPIC_NATIVE_AUTH_ENV_KEYS = [
  ANTHROPIC_API_KEY_ENV_KEY,
  // No shared constant exists for the auth-token env var; it is only referenced
  // here, so the literal is kept local rather than added to constants.ts.
  "ANTHROPIC_AUTH_TOKEN",
] as const;

/**
 * Runs `construct` with the Anthropic-native auth env vars removed, restoring
 * them afterward. `AnthropicVertex` extends the base Anthropic SDK, which reads
 * `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the environment and sends
 * them as an `Authorization` header — clobbering the Google OAuth token, so
 * Vertex rejects the request with `ACCESS_TOKEN_TYPE_UNSUPPORTED`. The Vertex
 * client `Omit`s those options, so neutralizing the env around its synchronous
 * constructor is the only way to prevent the leak (e.g. when a user configured
 * the `anthropic` provider earlier and left `ANTHROPIC_API_KEY` in their env).
 * Synchronous by design: there is no `await` between delete and restore, so it
 * is race-free.
 */
export function withAnthropicAuthEnvNeutralized<T>(construct: () => T): T {
  const saved = ANTHROPIC_NATIVE_AUTH_ENV_KEYS.map(
    (key) => [key, process.env[key]] as const,
  );

  for (const key of ANTHROPIC_NATIVE_AUTH_ENV_KEYS) {
    delete process.env[key];
  }

  try {
    return construct();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const VERTEX_AUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

let cachedGoogleAuth: GoogleAuth | null = null;

function getGoogleAuth(): GoogleAuth {
  cachedGoogleAuth ??= new GoogleAuth({ scopes: VERTEX_AUTH_SCOPE });

  return cachedGoogleAuth;
}

/**
 * Returns a `fetch` wrapper that injects a fresh Application Default Credentials
 * bearer token on every request. `GoogleAuth.getAccessToken()` caches and
 * auto-refreshes the token, so this keeps `createModel` synchronous while
 * surviving token expiry over long-running sessions. Used by the `openai-maas`
 * surface, whose OpenAI SDK client authenticates via the `Authorization` header
 * rather than ADC directly.
 */
export function createVertexAuthFetch(
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  const auth = getGoogleAuth();

  return async (input, init) => {
    const token = await auth.getAccessToken();

    if (!token) {
      throw new Error(
        "Failed to obtain a Google Cloud access token for Vertex AI. Check Application Default Credentials (gcloud auth application-default login).",
      );
    }

    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);

    return baseFetch(input, { ...init, headers });
  };
}
