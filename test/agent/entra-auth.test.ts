import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AccessToken } from "@azure/identity";
import { createModel } from "../../src/agent/index.ts";
import { createEntraTokenProvider } from "../../src/agent/entra-auth.ts";

const identityMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  getToken:
    vi.fn<
      (
        scopes: string | string[],
        options?: unknown,
      ) => Promise<AccessToken | null>
    >(),
}));

vi.mock("@azure/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/identity")>();

  return {
    ...actual,
    DefaultAzureCredential: class {
      constructor() {
        identityMocks.construct();
      }

      getToken(scopes: string | string[], options?: unknown) {
        return identityMocks.getToken(scopes, options);
      }
    },
  };
});

const BASE_URL = "https://gateway.example.com/openai/v1";
const SCOPE = "api://gateway/.default";
const TOKEN_LIFETIME_MS = 10 * 60 * 1000;
const CUSTOMER_TOKEN_LIFETIME_MS = 90 * 60 * 1000;

function accessToken(token: string, lifetimeMs = TOKEN_LIFETIME_MS) {
  return { token, expiresOnTimestamp: Date.now() + lifetimeMs };
}

beforeEach(() => {
  identityMocks.construct.mockReset();
  identityMocks.getToken.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createEntraTokenProvider", () => {
  test("constructs Azure Identity lazily and coalesces concurrent first requests", async () => {
    identityMocks.getToken.mockResolvedValue(accessToken("first-token"));
    const getToken = createEntraTokenProvider(BASE_URL, SCOPE);

    expect(identityMocks.construct).not.toHaveBeenCalled();
    expect(identityMocks.getToken).not.toHaveBeenCalled();

    expect(await Promise.all([getToken(), getToken(), getToken()])).toEqual([
      "first-token",
      "first-token",
      "first-token",
    ]);
    expect(identityMocks.construct).toHaveBeenCalledTimes(1);
    expect(identityMocks.getToken).toHaveBeenCalledTimes(1);
    expect(identityMocks.getToken).toHaveBeenCalledWith(
      [SCOPE],
      expect.any(Object),
    );
  });

  test("reuses the cached token while it remains valid", async () => {
    identityMocks.getToken.mockResolvedValue(accessToken("cached-token"));
    const getToken = createEntraTokenProvider(BASE_URL, SCOPE);

    expect(await getToken()).toBe("cached-token");
    expect(await getToken()).toBe("cached-token");
    expect(identityMocks.getToken).toHaveBeenCalledTimes(1);
  });

  test("refreshes an expired token without reconstructing the provider", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    identityMocks.getToken
      .mockResolvedValueOnce(accessToken("old-token", 5 * 60 * 1000))
      .mockImplementationOnce(() => Promise.resolve(accessToken("new-token")));
    const getToken = createEntraTokenProvider(BASE_URL, SCOPE);

    expect(await getToken()).toBe("old-token");
    vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z"));
    expect(await getToken()).toBe("new-token");
    expect(identityMocks.construct).toHaveBeenCalledTimes(1);
    expect(identityMocks.getToken).toHaveBeenCalledTimes(2);
  });

  test("retries token acquisition after a failure without exposing the SDK error", async () => {
    identityMocks.getToken
      .mockRejectedValueOnce(
        new Error("JWT and client secret must stay private"),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(accessToken("recovered-token")),
      );
    const getToken = createEntraTokenProvider(BASE_URL, SCOPE);

    const failure = await getToken().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "Unable to obtain a Microsoft Entra ID access token.",
    );
    expect((failure as Error).message).not.toContain("JWT and client secret");
    expect((failure as Error).cause).toBeUndefined();
    expect(await getToken()).toBe("recovered-token");
    expect(identityMocks.construct).toHaveBeenCalledTimes(1);
    expect(identityMocks.getToken).toHaveBeenCalledTimes(2);
  });

  test("retries lazy initialization after a constructor failure", async () => {
    identityMocks.construct.mockImplementationOnce(() => {
      throw new Error("private certificate password");
    });
    identityMocks.getToken.mockResolvedValue(accessToken("recovered-token"));
    const getToken = createEntraTokenProvider(BASE_URL, SCOPE);

    await expect(getToken()).rejects.toThrow(
      "Unable to obtain a Microsoft Entra ID access token.",
    );
    expect(await getToken()).toBe("recovered-token");
    expect(identityMocks.construct).toHaveBeenCalledTimes(2);
  });

  test.each([
    undefined,
    "not a URL",
    "http://gateway.example.com/v1",
    "file:///tmp/gateway",
    "gopher://gateway.example.com",
    "ftp://gateway.example.com",
    "data:text/plain,hello",
    "https://user:password@gateway.example.com/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://metadata.google.internal/v1",
    "https://metadata.google.internal./v1",
  ])("rejects an unsafe endpoint before acquiring credentials: %s", (url) => {
    expect(() => createEntraTokenProvider(url, SCOPE)).toThrow(
      /Entra ID authentication requires an HTTPS OPENAI_COMPATIBLE_BASE_URL/u,
    );
    expect(identityMocks.construct).not.toHaveBeenCalled();
    expect(identityMocks.getToken).not.toHaveBeenCalled();
  });
});

type ApiSurface = "chat" | "responses";
type Transport = "json" | "sse";

function toolCall() {
  return {
    id: "call_1",
    type: "function" as const,
    function: { name: "lookup", arguments: '{"q":"test"}' },
  };
}

function completionResponse() {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "gateway-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, tool_calls: [toolCall()] },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function responsesResponse() {
  return {
    id: "resp_test",
    object: "response",
    created_at: 0,
    model: "gateway-model",
    status: "completed",
    output: [
      {
        id: "fc_1",
        type: "function_call",
        status: "completed",
        call_id: "call_1",
        name: "lookup",
        arguments: '{"q":"test"}',
      },
    ],
    output_text: "",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

function eventStream(events: readonly unknown[]): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function gatewayResponse(surface: ApiSurface, transport: Transport): Response {
  if (transport === "json") {
    return new Response(
      JSON.stringify(
        surface === "chat" ? completionResponse() : responsesResponse(),
      ),
      { headers: { "content-type": "application/json" } },
    );
  }

  if (surface === "chat") {
    const chunk = {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "gateway-model",
    };
    return eventStream([
      { ...chunk, choices: [{ index: 0, delta: { role: "assistant" } }] },
      {
        ...chunk,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, ...toolCall() }] },
          },
        ],
      },
      {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ]);
  }

  const response = responsesResponse();
  const item = response.output[0];
  return eventStream([
    { type: "response.created", response },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]);
}

describe("OpenAI-compatible Entra requests", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    identityMocks.getToken.mockImplementation(() =>
      Promise.resolve({
        token: `fake-token-${identityMocks.getToken.mock.calls.length}`,
        expiresOnTimestamp: Date.now() + CUSTOMER_TOKEN_LIFETIME_MS,
      }),
    );
    vi.stubEnv("OPENAI_COMPATIBLE_AUTH", "entra-id");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", BASE_URL);
    vi.stubEnv("OPENAI_COMPATIBLE_ENTRA_SCOPE", SCOPE);
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "ignored-stale-key");
    vi.stubEnv("LANGSMITH_API_KEY", undefined);
    vi.stubEnv("LANGCHAIN_TRACING_V2", "false");
    vi.stubEnv("LANGSMITH_GATEWAY", "false");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test.each([
    ["chat", "json"],
    ["chat", "sse"],
    ["responses", "json"],
    ["responses", "sse"],
  ] as const)(
    "refreshes %s %s requests on one model",
    async (surface, transport) => {
      vi.stubEnv(
        "OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API",
        surface === "responses" ? "true" : undefined,
      );
      vi.stubEnv(
        "OPENWIKI_OPENAI_COMPATIBLE_STREAMING",
        transport === "sse" ? "true" : undefined,
      );

      const requests: Request[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          if (!request.url.startsWith(`${BASE_URL}/`)) {
            throw new Error(
              "Unexpected non-gateway request in Entra proof test",
            );
          }
          requests.push(request);
          return Promise.resolve(gatewayResponse(surface, transport));
        }),
      );

      const model = createModel("openai-compatible", "gateway-model", 0);
      const completions = (
        model as unknown as {
          completions: { getNumTokens: (content: unknown) => Promise<number> };
        }
      ).completions;
      vi.spyOn(completions, "getNumTokens").mockResolvedValue(1);
      const first = await model.invoke("first request");
      vi.setSystemTime(new Date(Date.now() + CUSTOMER_TOKEN_LIFETIME_MS + 1));
      const second = await model.invoke("request after expiry");

      for (const result of [first, second]) {
        expect(result.tool_calls).toMatchObject([
          { id: "call_1", name: "lookup", args: { q: "test" } },
        ]);
        expect(result.invalid_tool_calls).toEqual([]);
      }
      expect(requests).toHaveLength(2);
      expect(
        requests.map((request) => request.headers.get("authorization")),
      ).toEqual(["Bearer fake-token-1", "Bearer fake-token-2"]);
      expect(requests.map((request) => request.url)).toEqual([
        `${BASE_URL}/${surface === "chat" ? "chat/completions" : "responses"}`,
        `${BASE_URL}/${surface === "chat" ? "chat/completions" : "responses"}`,
      ]);
      const requestBodies = await Promise.all(
        requests.map(
          (request) => request.json() as Promise<{ stream?: boolean }>,
        ),
      );
      expect(requestBodies.map((body) => Boolean(body.stream))).toEqual([
        transport === "sse",
        transport === "sse",
      ]);
      expect(identityMocks.getToken).toHaveBeenCalledTimes(2);
      expect(identityMocks.construct).toHaveBeenCalledTimes(1);
    },
  );

  test("does not contact the gateway when token acquisition fails", async () => {
    identityMocks.getToken.mockRejectedValueOnce(
      new Error("fixture identity response with private details"),
    );
    vi.stubEnv("OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API", undefined);
    vi.stubEnv("OPENWIKI_OPENAI_COMPATIBLE_STREAMING", undefined);
    const fetchMock = vi.fn(() =>
      Promise.resolve(gatewayResponse("chat", "json")),
    );
    vi.stubGlobal("fetch", fetchMock);

    const model = createModel("openai-compatible", "gateway-model", 0);
    await expect(model.invoke("request without identity")).rejects.toThrow(
      "Unable to obtain a Microsoft Entra ID access token.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
