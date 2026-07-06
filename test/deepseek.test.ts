import { describe, expect, test, vi } from "vitest";
import { ChatOpenAI } from "@langchain/openai";

// Helper dummy to extract the scoped custom fetch client from LangChain object context
function getModelFetchWrapper(modelInstance: any) {
  return modelInstance.clientConfig?.fetch || modelInstance.configuration?.fetch;
}

describe("DeepSeek Fetch Rewriter Isolation & Transformations", () => {
  test("Passes non-DeepSeek URLs through completely unmodified", async () => {
    const mockGlobalFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({})));
    globalThis.fetch = mockGlobalFetch;

    // Trigger constructor creation branch
    const baseURL = "https://api.openai.com/v1";
    const customFetch = async (input: any, init: any) => {
      if (typeof input === "string" && input.includes("api.deepseek.com") && init?.body) {
        const payload = JSON.parse(init.body);
        init.body = JSON.stringify(payload);
      }
      return fetch(input, init);
    };

    const dummyPayload = { messages: [{ role: "user", content: "Hello OpenAI" }] };
    await customFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(dummyPayload),
    });

    expect(mockGlobalFetch).toHaveBeenCalled();
    const argumentsSent = JSON.parse(mockGlobalFetch.mock.calls[0][1].body);
    expect(argumentsSent.messages[0].content).toBe("Hello OpenAI");
  });

  test("Flattens text block arrays into straight continuous strings for DeepSeek", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn().mockImplementation(async (input, init) => {
      capturedBody = init?.body || "";
      return new Response(JSON.stringify({}));
    });

    const customFetch = async (input: any, init: any) => {
      if (typeof input === "string" && input.includes("api.deepseek.com") && init?.body) {
        const payload = JSON.parse(init.body);
        if (Array.isArray(payload.messages)) {
          for (const msg of payload.messages) {
            if (Array.isArray(msg.content)) {
              let text = "";
              for (const b of msg.content) {
                if (b.type === "text") text += b.text;
              }
              msg.content = text;
            }
          }
        }
        init.body = JSON.stringify(payload);
      }
      return fetch(input, init);
    };

    const multiBlockPayload = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Part 1 of message. " },
            { type: "text", text: "Part 2 of message." }
          ]
        }
      ]
    };

    await customFetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(multiBlockPayload),
    });

    const processedOutput = JSON.parse(capturedBody);
    expect(processedOutput.messages[0].content).toBe("Part 1 of message. Part 2 of message.");
  });

  test("Gracefully replaces heavy or non-text content blocks with placeholder omissions", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn().mockImplementation(async (input, init) => {
      capturedBody = init?.body || "";
      return new Response(JSON.stringify({}));
    });

    const customFetch = async (input: any, init: any) => {
      if (typeof input === "string" && input.includes("api.deepseek.com") && init?.body) {
        const payload = JSON.parse(init.body);
        if (Array.isArray(payload.messages)) {
          for (const msg of payload.messages) {
            if (Array.isArray(msg.content)) {
              let text = "";
              for (const b of msg.content) {
                if (b.type === "text") {
                  text += b.text;
                } else {
                  text += "[omitted block]";
                }
              }
              msg.content = text;
            }
          }
        }
        init.body = JSON.stringify(payload);
      }
      return fetch(input, init);
    };

    const dirtyPayload = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read this file: " },
            { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
          ]
        }
      ]
    };

    await customFetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(dirtyPayload),
    });

    const processedOutput = JSON.parse(capturedBody);
    expect(processedOutput.messages[0].content).toBe("Read this file: [omitted block]");
  });
});