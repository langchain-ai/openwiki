import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
const LONG_RETRY_AFTER_SECONDS = "60";
const INVALID_RETRY_AFTER_VALUE = "not-a-delay";
const PAST_RETRY_AFTER_DATE = "Thu, 01 Jan 1970 00:00:00 GMT";
const ABORT_ERROR_NAME = "AbortError";
const TEST_PROVIDER_URL = "https://api.example.test/responses";
const TRANSIENT_FETCH_ERROR_MESSAGE = "fetch failed";
const CANCEL_ERROR_MESSAGE = "cancel failed";
const EXPECTED_PROVIDER_CALLS_AFTER_ONE_RETRY =
  TEST_PROVIDER_RETRY_ATTEMPTS + 1;

describe("createModel OpenAI provider retry fetch", () => {
  let savedOpenAiApiKey: string | undefined;
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedOpenAiApiKey = process.env[OPENAI_API_KEY_ENV_KEY];
    savedFetch = globalThis.fetch;
    process.env[OPENAI_API_KEY_ENV_KEY] = TEST_API_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreEnv(OPENAI_API_KEY_ENV_KEY, savedOpenAiApiKey);
    globalThis.fetch = savedFetch;
    vi.restoreAllMocks();
  });

  test("retries provider rate-limit responses through the OpenAI SDK fetch", async () => {
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
    const model = createModel(
      OPENAI_PROVIDER,
      TEST_MODEL_ID,
      TEST_PROVIDER_RETRY_ATTEMPTS,
    ) as { caller?: { maxRetries?: number } };

    expect(model.caller?.maxRetries).toBe(DISABLED_LANGCHAIN_RETRY_ATTEMPTS);
  });

  test("returns the final transient fetch rejection after exhausting retries", async () => {
    const transientError = new Error(TRANSIENT_FETCH_ERROR_MESSAGE);
    const providerFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(transientError);
    globalThis.fetch = providerFetch;

    const model = createModel(
      OPENAI_PROVIDER,
      TEST_MODEL_ID,
      TEST_PROVIDER_RETRY_ATTEMPTS,
    ) as { clientConfig?: { fetch?: typeof globalThis.fetch } };

    await expect(model.clientConfig?.fetch?.(TEST_PROVIDER_URL)).rejects.toBe(
      transientError,
    );
    expect(providerFetch).toHaveBeenCalledTimes(
      EXPECTED_PROVIDER_CALLS_AFTER_ONE_RETRY,
    );
  });

  test.each([
    ["a missing Retry-After header", undefined],
    ["an invalid Retry-After header", INVALID_RETRY_AFTER_VALUE],
    ["an HTTP-date Retry-After header", PAST_RETRY_AFTER_DATE],
  ])("retries after %s", async (_caseName, retryAfter) => {
    vi.useFakeTimers();
    const headers =
      retryAfter === undefined
        ? undefined
        : { [RETRY_AFTER_HEADER_NAME]: retryAfter };
    const providerFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: RATE_LIMIT_STATUS, headers }),
      )
      .mockResolvedValueOnce(new Response(null, { status: SUCCESS_STATUS }));
    globalThis.fetch = providerFetch;

    const model = createModel(
      OPENAI_PROVIDER,
      TEST_MODEL_ID,
      TEST_PROVIDER_RETRY_ATTEMPTS,
    ) as { clientConfig?: { fetch?: typeof globalThis.fetch } };
    const responsePromise = model.clientConfig?.fetch?.(TEST_PROVIDER_URL);

    await vi.runAllTimersAsync();

    await expect(responsePromise).resolves.toMatchObject({
      status: SUCCESS_STATUS,
    });
    expect(providerFetch).toHaveBeenCalledTimes(
      EXPECTED_PROVIDER_CALLS_AFTER_ONE_RETRY,
    );
  });

  test("cancels a retryable response body before retrying", async () => {
    const cancel = vi.fn();
    const providerFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
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

    await model.clientConfig?.fetch?.(TEST_PROVIDER_URL);

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("retries when discarding a response body fails", async () => {
    const providerFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            cancel: () => Promise.reject(new Error(CANCEL_ERROR_MESSAGE)),
          }),
          {
            status: RATE_LIMIT_STATUS,
            headers: { [RETRY_AFTER_HEADER_NAME]: ZERO_RETRY_AFTER_SECONDS },
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: SUCCESS_STATUS }));
    globalThis.fetch = providerFetch;
    const model = createModel(
      OPENAI_PROVIDER,
      TEST_MODEL_ID,
      TEST_PROVIDER_RETRY_ATTEMPTS,
    ) as { clientConfig?: { fetch?: typeof globalThis.fetch } };

    await expect(
      model.clientConfig?.fetch?.(TEST_PROVIDER_URL),
    ).resolves.toMatchObject({ status: SUCCESS_STATUS });
    expect(providerFetch).toHaveBeenCalledTimes(
      EXPECTED_PROVIDER_CALLS_AFTER_ONE_RETRY,
    );
  });

  test("aborts while waiting to retry a rate-limit response", async () => {
    vi.useFakeTimers();
    const providerFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, {
        status: RATE_LIMIT_STATUS,
        headers: {
          [RETRY_AFTER_HEADER_NAME]: LONG_RETRY_AFTER_SECONDS,
        },
      }),
    );
    globalThis.fetch = providerFetch;
    const abortController = new AbortController();
    const model = createModel(
      OPENAI_PROVIDER,
      TEST_MODEL_ID,
      TEST_PROVIDER_RETRY_ATTEMPTS,
    ) as { clientConfig?: { fetch?: typeof globalThis.fetch } };
    const responsePromise = model.clientConfig?.fetch?.(TEST_PROVIDER_URL, {
      signal: abortController.signal,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    abortController.abort();

    await expect(responsePromise).rejects.toMatchObject({
      name: ABORT_ERROR_NAME,
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  test("does not start a retry delay for an already-aborted signal", async () => {
    const providerFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, {
        status: RATE_LIMIT_STATUS,
        headers: { [RETRY_AFTER_HEADER_NAME]: LONG_RETRY_AFTER_SECONDS },
      }),
    );
    globalThis.fetch = providerFetch;
    const abortController = new AbortController();
    abortController.abort();
    const model = createModel(
      OPENAI_PROVIDER,
      TEST_MODEL_ID,
      TEST_PROVIDER_RETRY_ATTEMPTS,
    ) as { clientConfig?: { fetch?: typeof globalThis.fetch } };

    await expect(
      model.clientConfig?.fetch?.(TEST_PROVIDER_URL, {
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({ name: ABORT_ERROR_NAME });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
