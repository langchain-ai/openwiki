import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { ChatExaone } from "langchain-exaone";
import { afterEach, expect, test, vi } from "vitest";

import { createModel } from "../../src/agent/index.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("EXAONE preserves reasoning through a tool call and forwards the requested effort", async () => {
  vi.stubEnv("EXAONE_API_KEY", "exaone-test-key");
  vi.stubEnv("EXAONE_BASE_URL", "https://example.test/v1");
  vi.stubEnv("OPENWIKI_REASONING_EFFORT", "medium");

  const requests: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    const message =
      requests.length === 1
        ? {
            role: "assistant",
            content: null,
            reasoning_content: "Inspect the README before writing.",
            tool_calls: [
              {
                id: "call_readme",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          }
        : { role: "assistant", content: "The README describes a wiki." };

    return Promise.resolve(
      Response.json({
        id: "test",
        model: "k-exaone_v2.5",
        choices: [
          {
            index: 0,
            message,
            finish_reason: requests.length === 1 ? "tool_calls" : "stop",
          },
        ],
      }),
    );
  });

  const model = createModel("exaone", "k-exaone_v2.5", 0, 2048);
  expect(model).toBeInstanceOf(ChatExaone);

  const prompt = new HumanMessage("Summarize the README.");
  const response = await model.invoke([prompt]);
  expect(response.tool_calls).toMatchObject([{ id: "call_readme" }]);

  const followup = await model.invoke([
    prompt,
    response,
    new ToolMessage({ tool_call_id: "call_readme", content: "# Wiki" }),
  ]);
  expect(followup.content).toBe("The README describes a wiki.");
  expect(requests).toHaveLength(2);
  expect(requests[1]?.url).toBe("https://example.test/v1/chat/completions");
  expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe(
    "Bearer exaone-test-key",
  );
  const body = requests[1]?.init?.body;
  if (typeof body !== "string")
    throw new Error("Expected a JSON request body.");
  expect(JSON.parse(body)).toMatchObject({
    model: "k-exaone_v2.5",
    reasoning_effort: "medium",
    max_tokens: 2048,
    chat_template_kwargs: { preserve_thinking: true },
    messages: [
      { role: "user" },
      {
        role: "assistant",
        reasoning_content: "Inspect the README before writing.",
        tool_calls: [{ id: "call_readme" }],
      },
      { role: "tool", tool_call_id: "call_readme" },
    ],
  });
});

test("EXAONE requires its own key rather than falling back to an OpenAI key", () => {
  vi.stubEnv("EXAONE_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "ambient-openai-key");
  vi.stubEnv("OPENWIKI_REASONING_EFFORT", undefined);
  expect(() => createModel("exaone", "k-exaone_v2.5", 0)).toThrow(
    "EXAONE_API_KEY is required",
  );
});
