import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ChatOpenRouter, OpenRouterError } from "@langchain/openrouter";
import { installOpenRouterDebugFetch } from "../src/agent/index.ts";
import { OPENROUTER_BASE_URL } from "../src/config/constants.ts";

// ChatOpenRouter calls globalThis.fetch directly (no injectable fetch), so the
// debug wrapper must patch the global. These tests pin the concurrency contract
// from issue #411: overlapping runs must each keep their own captured failure,
// and the real fetch must be restored exactly once — only after the last run
// detaches — so a patch can never leak or be lost.

const OPENROUTER_CHAT_URL = `${OPENROUTER_BASE_URL}/chat/completions`;
const OTHER_URL = "https://api.example.com/v1/chat/completions";
const MODEL = "openai/gpt-4o-mini";

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
});

afterEach(() => {
  // Guard against a test leaving the global patched.
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** A stub fetch that fails OpenRouter chat calls and passes everything else. */
function stubFetch(): typeof globalThis.fetch {
  const stub = vi.fn(
    (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(OPENROUTER_CHAT_URL)) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "rate limited" }), {
            status: 429,
            statusText: "Too Many Requests",
          }),
        );
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    },
  ) as unknown as typeof globalThis.fetch;
  globalThis.fetch = stub;
  return stub;
}

function stubFetchHandler(
  handler: (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
    call: number,
  ) => Response,
): typeof globalThis.fetch {
  let call = 0;
  const stub = vi.fn(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      call += 1;

      return Promise.resolve(handler(input, init, call));
    },
  ) as unknown as typeof globalThis.fetch;
  globalThis.fetch = stub;
  return stub;
}

function openRouterFetchInit(stream: boolean): RequestInit {
  return {
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      model: MODEL,
      stream,
    }),
    method: "POST",
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...init.headers },
    status: 200,
    statusText: "OK",
    ...init,
  });
}

function validChatCompletion(content = "ok"): Record<string, unknown> {
  return {
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        message: { content, role: "assistant" },
      },
    ],
    created: 0,
    id: "chatcmpl_test",
    model: MODEL,
    object: "chat.completion",
    usage: {
      completion_tokens: 1,
      prompt_tokens: 1,
      total_tokens: 2,
    },
  };
}

function createChatOpenRouter(maxRetries = 0): ChatOpenRouter {
  return new ChatOpenRouter({
    apiKey: "sk-or-v1-test",
    maxRetries,
    model: MODEL,
  });
}

async function expectOpenRouterMalformedError(
  promise: Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  let error: unknown;

  try {
    await promise;
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeDefined();
  expect(OpenRouterError.isInstance(error)).toBe(true);

  if (!OpenRouterError.isInstance(error)) {
    return;
  }

  expect(error.name).toBe("OpenRouterError");
  expect(error.statusCode).toBe(502);
  expect(error.message).toContain(
    "malformed successful non-streaming chat completion response",
  );
  expect(error.message).toContain(expectedMessage);
}

const malformedSuccessCases = [
  {
    bodyPreview: "",
    expectedMessage: "not valid JSON",
    name: "empty body",
    reason: "invalid_json",
    response: () =>
      new Response("", {
        headers: { "content-type": "application/json" },
        status: 200,
        statusText: "OK",
      }),
  },
  {
    bodyPreview: "{}",
    expectedMessage: "choices was missing or empty",
    name: "empty object",
    reason: "missing_choices",
    response: () => jsonResponse({}),
  },
  {
    bodyPreview: '{"choices":[{}]}',
    expectedMessage: "choices[0].message",
    name: "choice without message",
    reason: "missing_choices_0_message",
    response: () => jsonResponse({ choices: [{}] }),
  },
];

describe("installOpenRouterDebugFetch concurrency", () => {
  test("restores the exact original fetch after a single run", () => {
    const original = stubFetch();

    const capture = installOpenRouterDebugFetch({});
    expect(globalThis.fetch).not.toBe(original);

    capture.restore();
    expect(globalThis.fetch).toBe(original);
  });

  test("overlapping runs each capture their own failure and restore is reference-counted", async () => {
    const original = stubFetch();

    const events: string[] = [];
    const runA = installOpenRouterDebugFetch({});
    const runB = installOpenRouterDebugFetch({
      debug: true,
      onEvent: (e) => {
        if (e.type === "debug") {
          events.push(e.message);
        }
      },
    });

    // Only one wrapper is installed for both runs.
    const patched = globalThis.fetch;
    expect(patched).not.toBe(original);

    // An OpenRouter failure fans out to every active run's sink.
    await globalThis.fetch(OPENROUTER_CHAT_URL, {
      body: JSON.stringify({ model: "x", messages: [] }),
      method: "POST",
    });

    expect(runA.getLastFailure()?.response?.status).toBe(429);
    expect(runB.getLastFailure()?.response?.status).toBe(429);
    // Debug routing honors each run's options: only runB opted in.
    expect(events.some((m) => m.includes("openrouter.http status=429"))).toBe(
      true,
    );

    // runB can clear its own failure without touching runA's.
    runB.clearLastFailure();
    expect(runB.getLastFailure()).toBeNull();
    expect(runA.getLastFailure()?.response?.status).toBe(429);

    // First detach must NOT restore the global — runA is still active.
    runB.restore();
    expect(globalThis.fetch).toBe(patched);

    // Last detach restores the genuine original, not the wrapper.
    runA.restore();
    expect(globalThis.fetch).toBe(original);
  });

  test("passes non-OpenRouter requests through untouched", async () => {
    const original = stubFetch();
    const capture = installOpenRouterDebugFetch({});

    const response = await globalThis.fetch(OTHER_URL, { method: "POST" });

    expect(response.status).toBe(200);
    expect(capture.getLastFailure()).toBeNull();

    capture.restore();
    expect(globalThis.fetch).toBe(original);
  });

  test("redundant restore is a no-op and does not disturb an active run", () => {
    const original = stubFetch();
    const runA = installOpenRouterDebugFetch({});
    const runB = installOpenRouterDebugFetch({});
    const patched = globalThis.fetch;

    runA.restore();
    // Double restore of the same handle must not decrement twice and prematurely
    // restore while runB is still active.
    runA.restore();
    expect(globalThis.fetch).toBe(patched);

    runB.restore();
    expect(globalThis.fetch).toBe(original);
  });
});

describe("installOpenRouterDebugFetch malformed non-streaming responses", () => {
  test.each(malformedSuccessCases)(
    "converts $name to a retryable OpenRouter error response through fetch",
    async ({
      bodyPreview,
      expectedMessage,
      reason,
      response: createResponse,
    }) => {
      const original = stubFetchHandler(() => createResponse());
      const capture = installOpenRouterDebugFetch({});

      try {
        const response = await globalThis.fetch(
          OPENROUTER_CHAT_URL,
          openRouterFetchInit(false),
        );

        expect(response.status).toBe(502);
        expect(response.statusText).toBe("Bad Gateway");

        const body = (await response.clone().json()) as {
          error?: { message?: string };
        };
        expect(body.error?.message).toContain(
          "malformed successful non-streaming chat completion response",
        );
        expect(body.error?.message).toContain(expectedMessage);

        const error = await OpenRouterError.fromResponse(response);
        expect(error.statusCode).toBe(502);
        expect(error.code).toBe(502);
        expect(error.metadata).toMatchObject({
          openwiki_reason: "malformed_success_response",
          upstream_status: 200,
        });
        expect(error.message).toContain(expectedMessage);

        expect(capture.getLastFailure()).toMatchObject({
          request: { stream: false },
          response: {
            bodyPreview,
            malformedReason: reason,
            status: 502,
            upstreamStatus: 200,
          },
        });
      } finally {
        capture.restore();
      }

      expect(globalThis.fetch).toBe(original);
    },
  );

  test.each(malformedSuccessCases)(
    "converts $name to OpenRouterError through ChatOpenRouter",
    async ({ expectedMessage, reason, response: createResponse }) => {
      const original = stubFetchHandler(() => createResponse());
      const capture = installOpenRouterDebugFetch({});

      try {
        await expectOpenRouterMalformedError(
          createChatOpenRouter().invoke("hello"),
          expectedMessage,
        );

        expect(capture.getLastFailure()).toMatchObject({
          request: { stream: false },
          response: {
            malformedReason: reason,
            status: 502,
            upstreamStatus: 200,
          },
        });
      } finally {
        capture.restore();
      }

      expect(globalThis.fetch).toBe(original);
    },
  );

  test("lets ChatOpenRouter recover when a retry returns a valid response", async () => {
    const original = stubFetchHandler((_input, _init, call) =>
      call === 1
        ? jsonResponse({})
        : jsonResponse(validChatCompletion("recovered")),
    );
    const capture = installOpenRouterDebugFetch({});

    try {
      const message = await createChatOpenRouter(1).invoke("hello");

      expect(message.content).toBe("recovered");
      expect(capture.getLastFailure()).toMatchObject({
        response: {
          malformedReason: "missing_choices",
          status: 502,
          upstreamStatus: 200,
        },
      });
    } finally {
      capture.restore();
    }

    expect(globalThis.fetch).toBe(original);
  });

  test("leaves a valid non-streaming 200 response readable", async () => {
    const body = validChatCompletion("still readable");
    const original = stubFetchHandler(() => jsonResponse(body));
    const capture = installOpenRouterDebugFetch({});

    try {
      const response = await globalThis.fetch(
        OPENROUTER_CHAT_URL,
        openRouterFetchInit(false),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(body);
      expect(capture.getLastFailure()).toBeNull();
    } finally {
      capture.restore();
    }

    expect(globalThis.fetch).toBe(original);
  });

  test("does not parse or convert streaming OpenRouter responses", async () => {
    const original = stubFetchHandler(
      () =>
        new Response("", {
          headers: { "content-type": "text/event-stream" },
          status: 200,
          statusText: "OK",
        }),
    );
    const capture = installOpenRouterDebugFetch({});

    try {
      const response = await globalThis.fetch(
        OPENROUTER_CHAT_URL,
        openRouterFetchInit(true),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
      expect(capture.getLastFailure()).toBeNull();
    } finally {
      capture.restore();
    }

    expect(globalThis.fetch).toBe(original);
  });

  test("does not convert malformed non-OpenRouter responses", async () => {
    const original = stubFetchHandler(
      () => new Response("", { status: 200, statusText: "OK" }),
    );
    const capture = installOpenRouterDebugFetch({});

    try {
      const response = await globalThis.fetch(
        OTHER_URL,
        openRouterFetchInit(false),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
      expect(capture.getLastFailure()).toBeNull();
    } finally {
      capture.restore();
    }

    expect(globalThis.fetch).toBe(original);
  });
});
