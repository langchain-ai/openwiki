import { describe, expect, test, vi } from "vitest";
import { createDeepSeekFetchRewriter } from "../src/agent/index.ts";

function createMockFetch() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    return new Response("ok", { status: 200 });
  });
}

function buildRequest(body: unknown) {
  return {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  };
}

describe("createDeepSeekFetchRewriter", () => {
  test("passes through requests with string content unchanged", async () => {
    const mockFetch = createMockFetch();
    const rewriter = createDeepSeekFetchRewriter(mockFetch);

    const body = {
      messages: [{ role: "user", content: "Hello" }],
    };

    await rewriter("https://api.deepseek.com/v1/chat/completions", buildRequest(body));

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.messages[0].content).toBe("Hello");
  });

  test("flattens array content with text blocks", async () => {
    const mockFetch = createMockFetch();
    const rewriter = createDeepSeekFetchRewriter(mockFetch);

    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: "World" },
          ],
        },
      ],
    };

    await rewriter("https://api.deepseek.com/v1/chat/completions", buildRequest(body));

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.messages[0].content).toBe("Hello\nWorld");
  });

  test("replaces non-text blocks with omitted placeholder", async () => {
    const mockFetch = createMockFetch();
    const rewriter = createDeepSeekFetchRewriter(mockFetch);

    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Check this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
          ],
        },
      ],
    };

    await rewriter("https://api.deepseek.com/v1/chat/completions", buildRequest(body));

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.messages[0].content).toBe(
      "Check this\n[omitted image_url block]",
    );
  });

  test("replaces multiple non-text blocks", async () => {
    const mockFetch = createMockFetch();
    const rewriter = createDeepSeekFetchRewriter(mockFetch);

    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data: "..." },
            { type: "image", data: "..." },
          ],
        },
      ],
    };

    await rewriter("https://api.deepseek.com/v1/chat/completions", buildRequest(body));

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.messages[0].content).toBe(
      "[omitted file block]\n[omitted image block]",
    );
  });

  test("converts non-text-only content to omitted placeholders", async () => {
    const mockFetch = createMockFetch();
    const rewriter = createDeepSeekFetchRewriter(mockFetch);

    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }],
        },
      ],
    };

    await rewriter("https://api.deepseek.com/v1/chat/completions", buildRequest(body));

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.messages[0].content).toBe("[omitted image_url block]");
  });

  test("does not modify messages without array content", async () => {
    const mockFetch = createMockFetch();
    const rewriter = createDeepSeekFetchRewriter(mockFetch);

    const body = {
      messages: [
        { role: "system", content: "You are a helper." },
        { role: "user", content: "Hi" },
      ],
    };

    await rewriter("https://api.deepseek.com/v1/chat/completions", buildRequest(body));

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.messages[0].content).toBe("You are a helper.");
    expect(sentBody.messages[1].content).toBe("Hi");
  });

  test("handles mixed string and array content across messages", async () => {
    const mockFetch = createMockFetch();
    const rewriter = createDeepSeekFetchRewriter(mockFetch);

    const body = {
      messages: [
        { role: "system", content: "System prompt" },
        {
          role: "user",
          content: [
            { type: "text", text: "Part 1" },
            { type: "tool_result", content: "result" },
          ],
        },
      ],
    };

    await rewriter("https://api.deepseek.com/v1/chat/completions", buildRequest(body));

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.messages[0].content).toBe("System prompt");
    expect(sentBody.messages[1].content).toBe("Part 1\n[omitted tool_result block]");
  });

  test("passes through when body parsing fails", async () => {
    const mockFetch = createMockFetch();
    const rewriter = createDeepSeekFetchRewriter(mockFetch);

    const init = { method: "POST", body: "not-json" };

    await rewriter("https://api.deepseek.com/v1/chat/completions", init);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][1].body).toBe("not-json");
  });

  test("passes through when body has no messages field", async () => {
    const mockFetch = createMockFetch();
    const rewriter = createDeepSeekFetchRewriter(mockFetch);

    const body = { model: "deepseek-chat", stream: true };

    await rewriter("https://api.deepseek.com/v1/chat/completions", buildRequest(body));

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody).toEqual({ model: "deepseek-chat", stream: true });
  });

  test("passes through requests with no body", async () => {
    const mockFetch = createMockFetch();
    const rewriter = createDeepSeekFetchRewriter(mockFetch);

    await rewriter("https://api.deepseek.com/v1/chat/completions", { method: "GET" });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
  });

  test("preserves other request properties (method, headers)", async () => {
    const mockFetch = createMockFetch();
    const rewriter = createDeepSeekFetchRewriter(mockFetch);

    const init = {
      method: "POST",
      headers: { Authorization: "Bearer sk-xxx" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    };

    await rewriter("https://api.deepseek.com/v1/chat/completions", init);

    expect(mockFetch.mock.calls[0][1].method).toBe("POST");
    expect(mockFetch.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer sk-xxx" });
  });

  test("does not mutate the original body object", async () => {
    const mockFetch = createMockFetch();
    const rewriter = createDeepSeekFetchRewriter(mockFetch);

    const originalContent = [
      { type: "text", text: "Hello" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ];
    const body = {
      messages: [{ role: "user", content: originalContent }],
    };
    const init = buildRequest(body);

    await rewriter("https://api.deepseek.com/v1/chat/completions", init);

    // Original content array should not be modified
    expect(originalContent).toHaveLength(2);
    expect(originalContent[0]).toEqual({ type: "text", text: "Hello" });
  });

  test("each instance uses independent original fetch", async () => {
    const mockFetch1 = createMockFetch();
    const mockFetch2 = createMockFetch();
    const rewriter1 = createDeepSeekFetchRewriter(mockFetch1);
    const rewriter2 = createDeepSeekFetchRewriter(mockFetch2);

    const body = { messages: [{ role: "user", content: "Hi" }] };

    await rewriter1("https://api.deepseek.com/v1/chat/completions", buildRequest(body));
    await rewriter2("https://api.deepseek.com/v1/chat/completions", buildRequest(body));

    expect(mockFetch1).toHaveBeenCalledOnce();
    expect(mockFetch2).toHaveBeenCalledOnce();
  });
});
