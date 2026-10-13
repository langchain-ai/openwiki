import { afterEach, describe, expect, test, vi } from "vitest";
import { createModel } from "../../src/agent/index.ts";
import {
  getDefaultModelId,
  getMissingProviderEnvKey,
  getProviderModelOptions,
  resolveConfiguredProvider,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "../../src/config/constants.ts";
import { MANAGED_ENV_KEYS } from "../../src/config/env.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Tsubasa", () => {
  test("offers both aliases and resolves its managed credential", () => {
    expect(SELECTABLE_OPENWIKI_PROVIDERS).toContain("tsubasa");
    expect(getDefaultModelId("tsubasa")).toBe("tsubasa-fast");
    expect(getProviderModelOptions("tsubasa").map(({ id }) => id)).toEqual([
      "tsubasa-fast",
      "tsubasa-pro",
    ]);
    expect(MANAGED_ENV_KEYS).toContain("TSUBASA_API_KEY");
    expect(getMissingProviderEnvKey("tsubasa", {})).toBe("TSUBASA_API_KEY");
    expect(resolveConfiguredProvider({ TSUBASA_API_KEY: "test-key" })).toBe(
      "tsubasa",
    );
    expect(
      getMissingProviderEnvKey("tsubasa", { TSUBASA_API_KEY: "test-key" }),
    ).toBeNull();
  });

  test.each(["tsubasa-fast", "tsubasa-pro"])(
    "%s uses the chat endpoint and its own key for normal and streaming calls",
    async (modelId) => {
      vi.stubEnv("TSUBASA_API_KEY", "test-tsubasa-key");
      vi.stubEnv("OPENAI_API_KEY", "test-unrelated-key");
      vi.stubEnv("OPENAI_BASE_URL", "https://unrelated.example/v1");
      vi.stubEnv("OPENWIKI_MAX_OUTPUT_TOKENS", "4096");
      vi.stubEnv("OPENWIKI_REASONING_EFFORT", undefined);
      const requests: Record<string, unknown>[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL, init: RequestInit) => {
          expect(String(url)).toBe(
            "https://api.tsubasa.sh/v1/chat/completions",
          );
          expect(new Headers(init.headers).get("authorization")).toBe(
            "Bearer test-tsubasa-key",
          );
          if (typeof init.body !== "string") {
            throw new Error("Expected a JSON request body");
          }
          const body = JSON.parse(init.body) as Record<string, unknown>;
          requests.push(body);
          expect(body.model).toBe(modelId);
          expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
          expect(body.max_completion_tokens ?? body.max_tokens).toBe(4096);
          expect(body).not.toHaveProperty("reasoning_effort");
          if (body.stream) {
            return Promise.resolve(
              new Response(
                `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } },
              ),
            );
          }
          return Promise.resolve(
            Response.json({
              id: "chatcmpl-fixture",
              object: "chat.completion",
              created: 1,
              model: modelId,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "Hello" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            }),
          );
        }),
      );

      const model = createModel("tsubasa", modelId, 0);
      expect((await model.invoke("Hello")).content).toBe("Hello");
      let streamed = "";
      for await (const chunk of await model.stream("Hello")) {
        if (typeof chunk.content !== "string") {
          throw new Error("Expected a text response");
        }
        streamed += chunk.content;
      }
      expect(streamed).toBe("Hello");
      expect(requests.map(({ stream }) => stream)).toEqual([false, true]);
    },
  );
});
