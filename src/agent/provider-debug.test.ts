import { describe, expect, it, vi } from "vitest";
import {
  analyzeProviderMessages,
  attachProviderDebugInfo,
  installProviderDebugFetch,
  isProviderLlmFetchInput,
  summarizeProviderRequest,
} from "./provider-debug.js";

describe("isProviderLlmFetchInput", () => {
  it("matches LangSmith OpenAI gateway chat completions", () => {
    expect(
      isProviderLlmFetchInput(
        "https://gateway.smith.langchain.com/openai/v1/chat/completions",
      ),
    ).toBe(true);
  });

  it("matches OpenAI responses API", () => {
    expect(isProviderLlmFetchInput("https://api.openai.com/v1/responses")).toBe(
      true,
    );
  });

  it("ignores unrelated URLs", () => {
    expect(
      isProviderLlmFetchInput("https://api.smith.langchain.com/info"),
    ).toBe(false);
  });
});

describe("analyzeProviderMessages", () => {
  it("flags read_file tool messages with unsupported file content blocks", () => {
    const messages = [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_read_file",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ file_path: "/openwiki/logo.png" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_read_file",
        name: "read_file",
        content: [
          {
            type: "file",
            mimeType: "application/pdf",
            data: "YmFzZTY0",
          },
        ],
      },
    ];

    const analysis = analyzeProviderMessages(messages);

    expect(analysis.issues).toEqual([
      "messages[1] role=tool toolName=read_file has content block type=file (unsupported on chat-completions for many models)",
      "messages[1] role=tool content[0] type=file fileKeys=none",
    ]);
    expect(analysis.summaries[1]).toMatchObject({
      index: 1,
      role: "tool",
      toolName: "read_file",
      contentTypes: ["file"],
      toolArgsPreview: JSON.stringify({ file_path: "/openwiki/logo.png" }),
    });
  });

  it("accepts plain text tool messages", () => {
    const analysis = analyzeProviderMessages([
      {
        role: "tool",
        tool_call_id: "call_ls",
        name: "ls",
        content: "README.md\nsrc/",
      },
    ]);

    expect(analysis.issues).toEqual([]);
    expect(analysis.summaries[0]?.contentTypes).toEqual(["text"]);
  });
});

describe("summarizeProviderRequest", () => {
  it("summarizes chat-completions requests with message content issues", () => {
    const body = JSON.stringify({
      model: "gpt-5.5",
      stream: true,
      messages: [
        { role: "user", content: "hello" },
        {
          role: "tool",
          tool_call_id: "call_1",
          name: "read_file",
          content: [{ type: "file", mimeType: "application/pdf", data: "abc" }],
        },
      ],
      tools: [{ type: "function", function: { name: "read_file" } }],
    });

    const summary = summarizeProviderRequest(
      "https://gateway.smith.langchain.com/openai/v1/chat/completions",
      { method: "POST", body },
    );

    expect(summary.apiKind).toBe("chat-completions");
    expect(summary.model).toBe("gpt-5.5");
    expect(summary.messageCount).toBe(2);
    expect(summary.messageContentIssues).toHaveLength(2);
    expect(summary.toolCount).toBe(1);
  });
});

describe("installProviderDebugFetch", () => {
  it("captures OpenAI 400 responses and attaches providerDebug to errors", async () => {
    const mockBackend = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message:
              "Invalid value: 'file'. Supported values are: 'text', 'refusal', 'image_url', and 'input_audio'.",
            type: "invalid_request_error",
            param: "messages[0].content[0]",
            code: "invalid_value",
          },
        }),
        {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-type": "application/json" },
        },
      );
    });

    globalThis.fetch = mockBackend as typeof fetch;

    const debugMessages: string[] = [];
    const capture = installProviderDebugFetch({
      onDebug: (message) => debugMessages.push(message),
    });

    const requestBody = JSON.stringify({
      model: "gpt-5.5",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ file_path: "/logo.png" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          name: "read_file",
          content: [{ type: "file", mimeType: "application/pdf", data: "abc" }],
        },
      ],
    });

    const response = await fetch(
      "https://gateway.smith.langchain.com/openai/v1/chat/completions",
      {
        method: "POST",
        body: requestBody,
      },
    );

    expect(response.status).toBe(400);

    const failure = capture.getLastFailure();

    expect(failure).not.toBeNull();
    expect(failure?.response?.status).toBe(400);
    expect(failure?.request.messageContentIssues[0]).toContain("read_file");
    expect(failure?.request.messageContentIssues[0]).toContain("type=file");
    expect(
      debugMessages.some((message) => message.includes("contentIssue")),
    ).toBe(true);

    const error = new Error("400 Invalid value: 'file'.");
    attachProviderDebugInfo(error, failure);

    expect(
      (error as Error & { providerDebug?: unknown }).providerDebug,
    ).toEqual(failure);

    capture.restore();
  });

  it("uses responses API URLs without treating them as chat-completions", () => {
    const summary = summarizeProviderRequest(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.5", input: [] }),
      },
    );

    expect(summary.apiKind).toBe("openai-responses");
  });
});
