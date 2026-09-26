import { ChatGoogle, type ChatGoogleParams } from "@langchain/google/node";
import { OPENWIKI_VERTEX_LABELS_ENV_KEY } from "../config/constants.js";

export type VertexLabels = Record<string, string>;

// Google Cloud permits international lowercase letters and uncased scripts in
// addition to ASCII letters, digits, underscores and dashes.
const LABEL_KEY_PATTERN = /^[\p{Ll}\p{Lo}][\p{Ll}\p{Lo}\p{Nd}_-]*$/u;
const LABEL_VALUE_PATTERN = /^[\p{Ll}\p{Lo}\p{Nd}_-]*$/u;

export function parseVertexLabels(
  raw: string | undefined,
): VertexLabels | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${OPENWIKI_VERTEX_LABELS_ENV_KEY} must be a JSON object of string labels.`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${OPENWIKI_VERTEX_LABELS_ENV_KEY} must be a JSON object of string labels.`,
    );
  }

  const entries = Object.entries(parsed);
  if (entries.length > 64) {
    throw new Error(
      `${OPENWIKI_VERTEX_LABELS_ENV_KEY} supports at most 64 labels for Google models.`,
    );
  }

  for (const [key, value] of entries) {
    if (Array.from(key).length > 63 || !LABEL_KEY_PATTERN.test(key)) {
      throw new Error(
        `${OPENWIKI_VERTEX_LABELS_ENV_KEY} contains an invalid label key.`,
      );
    }
    if (
      typeof value !== "string" ||
      Array.from(value).length > 63 ||
      !LABEL_VALUE_PATTERN.test(value)
    ) {
      throw new Error(
        `${OPENWIKI_VERTEX_LABELS_ENV_KEY} contains an invalid label value.`,
      );
    }
  }

  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** ChatGoogle builds both regular and streaming request bodies from invocationParams. */
export class LabeledVertexChatGoogle extends ChatGoogle {
  constructor(
    params: ChatGoogleParams,
    private readonly vertexLabels: VertexLabels,
  ) {
    super(params);
  }

  override invocationParams(
    options: Parameters<ChatGoogle["invocationParams"]>[0],
  ): ReturnType<ChatGoogle["invocationParams"]> & { labels: VertexLabels } {
    return { ...super.invocationParams(options), labels: this.vertexLabels };
  }
}
