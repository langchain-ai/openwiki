import {
  OPENWIKI_REASONING_EFFORT_ENV_KEY,
  type OpenWikiProvider,
} from "./constants.js";

export const REASONING_EFFORT_VALUES = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

export type ReasoningTransport =
  | "responses-reasoning"
  | "chat-completions-reasoning-effort"
  | "openrouter-reasoning";

export type ReasoningCapability = {
  transport: ReasoningTransport;
  values: readonly ReasoningEffort[];
};

export type ResolvedReasoningConfig = {
  effort: ReasoningEffort;
  transport: ReasoningTransport;
};

const OPENAI_GPT_56_REASONING_CAPABILITY = {
  transport: "responses-reasoning",
  values: REASONING_EFFORT_VALUES,
} as const satisfies ReasoningCapability;

const REASONING_CAPABILITIES: Partial<
  Record<OpenWikiProvider, Readonly<Record<string, ReasoningCapability>>>
> = {
  openai: {
    "gpt-5.6-terra": OPENAI_GPT_56_REASONING_CAPABILITY,
    "gpt-5.6-luna": OPENAI_GPT_56_REASONING_CAPABILITY,
    "gpt-5.6-sol": OPENAI_GPT_56_REASONING_CAPABILITY,
  },
  "openai-chatgpt": {
    "gpt-5.6-terra": OPENAI_GPT_56_REASONING_CAPABILITY,
    "gpt-5.6-luna": OPENAI_GPT_56_REASONING_CAPABILITY,
    "gpt-5.6-sol": OPENAI_GPT_56_REASONING_CAPABILITY,
  },
  nvidia: {
    "nvidia/nemotron-3-super-120b-a12b": {
      transport: "chat-completions-reasoning-effort",
      values: ["none", "low", "high"],
    },
  },
};

/**
 * Capabilities that hold for every model a provider serves, consulted only
 * when the per-model table above has no entry.
 *
 * OpenRouter is a gateway, not a model vendor: it publishes one normalized
 * `reasoning.effort` parameter and maps it onto whatever the upstream model
 * expects, so the effort scale is a property of the gateway rather than of
 * any single model ID. Its documented values are `max`, `xhigh`, `high`,
 * `medium`, `low`, `minimal`, and `none` -- a superset of
 * REASONING_EFFORT_VALUES. Enumerating its catalogue here is not an option:
 * it routes hundreds of models and adds more continuously, so a per-model
 * table would reject valid combinations the day a model lands.
 *
 * The trade-off is that a non-reasoning model reached through OpenRouter no
 * longer fails before the request. That matches the trust boundary the
 * provider already carries for `provider.only` routing preferences: OpenWiki
 * forwards what the user configured and lets the gateway reject what it
 * cannot serve.
 *
 * See https://openrouter.ai/docs/use-cases/reasoning-tokens.
 */
const PROVIDER_WIDE_REASONING_CAPABILITIES: Partial<
  Record<OpenWikiProvider, ReasoningCapability>
> = {
  openrouter: {
    transport: "openrouter-reasoning",
    values: REASONING_EFFORT_VALUES,
  },
};

export function getReasoningCapability(
  provider: OpenWikiProvider,
  modelId: string,
): ReasoningCapability | undefined {
  return (
    REASONING_CAPABILITIES[provider]?.[modelId] ??
    PROVIDER_WIDE_REASONING_CAPABILITIES[provider]
  );
}

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}

export function resolveReasoningConfig(
  provider: OpenWikiProvider,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedReasoningConfig | undefined {
  const rawEffort = env[OPENWIKI_REASONING_EFFORT_ENV_KEY];

  if (rawEffort === undefined) {
    return undefined;
  }

  const effort = rawEffort.trim();

  if (!isReasoningEffort(effort)) {
    throw new Error(
      `Invalid ${OPENWIKI_REASONING_EFFORT_ENV_KEY}. Expected one of: ${REASONING_EFFORT_VALUES.join(", ")}.`,
    );
  }

  const capability = getReasoningCapability(provider, modelId);

  if (capability === undefined) {
    throw new Error(
      `${OPENWIKI_REASONING_EFFORT_ENV_KEY} is not supported for provider "${provider}" and model "${modelId}".`,
    );
  }

  if (!capability.values.includes(effort)) {
    throw new Error(
      `Invalid ${OPENWIKI_REASONING_EFFORT_ENV_KEY} value "${effort}" for provider "${provider}" and model "${modelId}". Supported values: ${capability.values.join(", ")}.`,
    );
  }

  return { effort, transport: capability.transport };
}
