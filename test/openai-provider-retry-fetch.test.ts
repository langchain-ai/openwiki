import { afterEach, describe, expect, test, vi } from "vitest";
import { createModel } from "../src/agent/index.ts";

const OPENAI_API_KEY_ENV_KEY = "OPENAI_API_KEY";
const TEST_API_KEY = "test-openai-key";
const TEST_MODEL_ID = "gpt-5.6-terra";
const TEST_PROVIDER_RETRY_ATTEMPTS = 1;
const DISABLED_LANGCHAIN_RETRY_ATTEMPTS = 0;
const OPENAI_PROVIDER = "openai";
const RATE_LIMIT_STATUS = 429;
const SUCCESS_STATUS = 200;
const FUNCTION_TYPE = "function";
const RETRY_AFTER_HEADER_NAME = "retry-after";
const ZERO_RETRY_AFTER_SECONDS = "0";
const TEST_PROVIDER_URL = "https://api.example.test/responses";
const TRANSIENT_FETCH_ERROR_MESSAGE = "fetch failed";
const EXPECTED_PROVIDER_CALLS_AFTER_ONE_RETRY =
  TEST_PROVIDER_RETRY_ATTEMPTS + 1;

describe("createModel OpenAI provider retry fetch", () => {
  let savedOpenAiApiKey: string | undefined;
  let savedFetch: typeof globalThis.fetch;

  afterEach(() => {
    restoreEnv(OPENAI_API_KEY_ENV_KEY, savedOpenAiApiKey);
    globalThis.fetch = savedFetch;
    vi.restoreAllMocks();
  });

  test("retries provider rate-limit responses through the OpenAI SDK fetch", async () => {
    savedOpenAiApiKey = process.env[OPENAI_API_KEY_ENV_KEY];
    savedFetch = globalThis.fetch;
    process.env[OPENAI_API_KEY_ENV_KEY] = TEST_API_KEY;

    const providerFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: RATE_LIMIT_STATUS,
          headers: { [RETRY_AFTER_HEADER_NAME]: ZERO_RETRY_AFTER_SECONDS },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: SUCCESS_STATUS }));
    globalThis.fetch = providerFetch;

    const model = createModel(
      OPENAI_PROVIDER,
      TEST_MODEL_ID,
      TEST_PROVIDER_RETRY_ATTEMPTS,
    ) as { clientConfig?: { fetch?: typeof globalThis.fetch } };

    const retryFetch = model.clientConfig?.fetch;

    expect(retryFetch).toBeTypeOf(FUNCTION_TYPE);

    const response = await retryFetch?.(TEST_PROVIDER_URL);

    expect(response?.status).toBe(SUCCESS_STATUS);
    expect(providerFetch).toHaveBeenCalledTimes(
      EXPECTED_PROVIDER_CALLS_AFTER_ONE_RETRY,
    );
  });

  test("retries transient fetch rejections through the same retry budget", async () => {
    savedOpenAiApiKey = process.env[OPENAI_API_KEY_ENV_KEY];
    savedFetch = globalThis.fetch;
    process.env[OPENAI_API_KEY_ENV_KEY] = TEST_API_KEY;

    const providerFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error(TRANSIENT_FETCH_ERROR_MESSAGE))
      .mockResolvedValueOnce(new Response(null, { status: SUCCESS_STATUS }));
    globalThis.fetch = providerFetch;

    const model = createModel(
      OPENAI_PROVIDER,
      TEST_MODEL_ID,
      TEST_PROVIDER_RETRY_ATTEMPTS,
    ) as { clientConfig?: { fetch?: typeof globalThis.fetch } };

    const response = await model.clientConfig?.fetch?.(TEST_PROVIDER_URL);

    expect(response?.status).toBe(SUCCESS_STATUS);
    expect(providerFetch).toHaveBeenCalledTimes(
      EXPECTED_PROVIDER_CALLS_AFTER_ONE_RETRY,
    );
  });

  test("uses the fetch wrapper as the single retry budget", () => {
    savedOpenAiApiKey = process.env[OPENAI_API_KEY_ENV_KEY];
    savedFetch = globalThis.fetch;
    process.env[OPENAI_API_KEY_ENV_KEY] = TEST_API_KEY;

    const model = createModel(
      OPENAI_PROVIDER,
      TEST_MODEL_ID,
      TEST_PROVIDER_RETRY_ATTEMPTS,
    ) as { caller?: { maxRetries?: number } };

    expect(model.caller?.maxRetries).toBe(DISABLED_LANGCHAIN_RETRY_ATTEMPTS);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
