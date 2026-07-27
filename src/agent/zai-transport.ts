import {
  ZAI_DEFAULT_BASE_URL,
  ZAI_RATE_LIMIT_BASE_DELAY_MS_ENV_KEY,
  ZAI_RATE_LIMIT_MAX_DELAY_MS_ENV_KEY,
  ZAI_RATE_LIMIT_MAX_RETRIES_ENV_KEY,
} from "../constants.js";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 300_000;

export type ZaiTransportDependencies = {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
};

type ZaiRateLimitConfig = {
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
};

/**
 * Returns a fetch implementation scoped to a Z.AI ChatOpenAI client. It never
 * mutates global fetch and bypasses both normalization and retries for requests
 * outside the configured Z.AI API root.
 */
export function createZaiFetch(
  dependencies: ZaiTransportDependencies = {},
): typeof fetch {
  const baseUrl = dependencies.baseUrl ?? ZAI_DEFAULT_BASE_URL;
  const env = dependencies.env ?? process.env;
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;

  return async (input, init) => {
    if (!isZaiRequest(input, baseUrl)) {
      return fetchImplementation(input, init);
    }

    const normalizedRequest = await normalizeZaiRequest(input, init);
    const config = resolveZaiRateLimitConfig(env);

    for (let retryNumber = 0; ; retryNumber += 1) {
      const retryInput =
        normalizedRequest.input instanceof Request
          ? normalizedRequest.input.clone()
          : normalizedRequest.input;
      const response = await fetchImplementation(
        retryInput,
        normalizedRequest.init,
      );

      if (response.status !== 429 || retryNumber >= config.maxRetries) {
        return response;
      }

      await sleep(getZaiRetryDelayMs(response, retryNumber + 1, config, now));
    }
  };
}

/** Normalizes only file blocks contained in a JSON chat-completions body. */
export function normalizeZaiRequestBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);

    if (!isRecord(parsed)) {
      return body;
    }

    const parsedMessages = parsed.messages;
    if (!Array.isArray(parsedMessages)) {
      return body;
    }

    let changed = false;
    const messages = (parsedMessages as unknown[]).map((message) => {
      if (!isRecord(message)) {
        return message;
      }

      const messageContent = message.content;
      if (!Array.isArray(messageContent)) {
        return message;
      }

      let messageChanged = false;
      const content = (messageContent as unknown[]).map((block) => {
        const normalized = normalizeZaiContentBlock(block);
        messageChanged ||= normalized !== block;
        return normalized;
      });

      changed ||= messageChanged;
      return messageChanged ? { ...message, content } : message;
    });

    return changed ? JSON.stringify({ ...parsed, messages }) : body;
  } catch {
    return body;
  }
}

export function parseZaiRetryAfterMs(
  headers: Headers,
  now: () => number = Date.now,
): number | null {
  const retryAfter = headers.get("retry-after")?.trim();

  if (!retryAfter) {
    return null;
  }

  if (/^\d+(?:\.\d+)?$/u.test(retryAfter)) {
    return Number(retryAfter) * 1_000;
  }

  const retryAt = Date.parse(retryAfter);
  return Number.isNaN(retryAt) ? null : Math.max(0, retryAt - now());
}

export function resolveZaiRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): ZaiRateLimitConfig {
  const baseDelayMs = readPositiveInteger(
    ZAI_RATE_LIMIT_BASE_DELAY_MS_ENV_KEY,
    env,
    DEFAULT_BASE_DELAY_MS,
  );
  const maxDelayMs = readPositiveInteger(
    ZAI_RATE_LIMIT_MAX_DELAY_MS_ENV_KEY,
    env,
    DEFAULT_MAX_DELAY_MS,
  );

  return {
    baseDelayMs,
    maxDelayMs,
    maxRetries: readNonNegativeInteger(
      ZAI_RATE_LIMIT_MAX_RETRIES_ENV_KEY,
      env,
      DEFAULT_MAX_RETRIES,
    ),
  };
}

function normalizeRequestInit(
  init: RequestInit | undefined,
): RequestInit | undefined {
  if (typeof init?.body !== "string") {
    return init;
  }

  const body = normalizeZaiRequestBody(init.body);
  return body === init.body ? init : { ...init, body };
}

async function normalizeZaiRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<{ input: RequestInfo | URL; init: RequestInit | undefined }> {
  const normalizedInit = normalizeRequestInit(init);

  if (
    !(input instanceof Request) ||
    init?.body !== undefined ||
    typeof input.body !== "object" ||
    input.body === null
  ) {
    return { input, init: normalizedInit };
  }

  const body = await input.clone().text();
  const normalizedBody = normalizeZaiRequestBody(body);

  if (normalizedBody === body) {
    return { input, init: normalizedInit };
  }

  return {
    input: new Request(input, { body: normalizedBody }),
    init: normalizedInit,
  };
}

function normalizeZaiContentBlock(block: unknown): unknown {
  if (!isRecord(block) || block.type !== "file") {
    return block;
  }

  const text = normalizeZaiFileData(block.data);
  return { type: "text", text };
}

function normalizeZaiFileData(data: unknown): string {
  if (typeof data !== "string" || data.trim().length === 0) {
    return "[file content omitted]";
  }

  const compact = data.trim();
  if (!looksLikeBase64(compact)) {
    return data;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(compact, "base64"),
    );
  } catch {
    // An alphanumeric word such as "text" is syntactically indistinguishable
    // from unpadded base64. Preserve that readable input; delimiters/padding
    // make an invalid payload unambiguously encoded binary.
    return /[+/=]/u.test(compact) ? "[binary file content omitted]" : data;
  }
}

function looksLikeBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/=\r\n]+$/u.test(value);
}

function getZaiRetryDelayMs(
  response: Response,
  retryNumber: number,
  config: ZaiRateLimitConfig,
  now: () => number,
): number {
  const retryAfterMs = parseZaiRetryAfterMs(response.headers, now);

  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, config.maxDelayMs);
  }

  return Math.min(
    config.baseDelayMs * 2 ** (retryNumber - 1),
    config.maxDelayMs,
  );
}

function isZaiRequest(input: RequestInfo | URL, baseUrl: string): boolean {
  try {
    const requestUrl = new URL(getRequestUrl(input));
    const configuredBaseUrl = new URL(baseUrl);
    const basePath = configuredBaseUrl.pathname.replace(/\/+$/u, "");

    return (
      requestUrl.origin === configuredBaseUrl.origin &&
      (requestUrl.pathname === basePath ||
        requestUrl.pathname.startsWith(`${basePath}/`))
    );
  } catch {
    return false;
  }
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

function readNonNegativeInteger(
  key: string,
  env: NodeJS.ProcessEnv,
  fallback: number,
): number {
  const rawValue = env[key];

  if (rawValue === undefined) {
    return fallback;
  }

  if (!/^\d+$/u.test(rawValue)) {
    throw new Error(`${key} must be a non-negative integer.`);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${key} must be a non-negative integer.`);
  }

  return value;
}

function readPositiveInteger(
  key: string,
  env: NodeJS.ProcessEnv,
  fallback: number,
): number {
  const value = readNonNegativeInteger(key, env, fallback);

  if (value === 0) {
    throw new Error(`${key} must be a positive integer.`);
  }

  return value;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
