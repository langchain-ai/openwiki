import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { ChatOpenAI } from "@langchain/openai";
import { afterEach, describe, expect, test } from "vitest";
import { createOpenWikiAgent } from "../../src/agent/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("createOpenWikiAgent", () => {
  test("requires an absolute runtime root", async () => {
    await expect(
      createOpenWikiAgent({
        command: "init",
        cwd: "relative-repository",
        model: new FakeListChatModel({ responses: ["done"] }),
        outputMode: "repository",
      }),
    ).rejects.toThrow("OpenWiki agent cwd must be an absolute path.");
  });

  test("rejects repository generation before constructing the legacy graph", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-agent-"));
    temporaryDirectories.push(cwd);

    for (const command of ["init", "update"] as const) {
      await expect(
        createOpenWikiAgent({
          command,
          cwd,
          model: new FakeListChatModel({ responses: ["done"] }),
          outputMode: "repository",
        }),
      ).rejects.toThrow(
        "Repository init/update use the OpenWiki page-job runner",
      );
    }
  });

  test("constructs a graph from an initialized chat model", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-agent-"));
    temporaryDirectories.push(cwd);

    const agent = await createOpenWikiAgent({
      command: "init",
      cwd,
      model: new FakeListChatModel({ responses: ["done"] }),
      outputMode: "local-wiki",
    });

    expect(agent).toHaveProperty("invoke");
    expect(agent).toHaveProperty("streamEvents");
  });

  test("accepts streamed replies whose first delta has no assistant role", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-agent-"));
    temporaryDirectories.push(cwd);
    // Reasoning-first OpenAI-compatible streams (z.ai GLM) send role:"assistant"
    // only after a reasoning delta, so LangChain aggregates a ChatMessageChunk.
    const replies = [
      [
        { reasoning_content: "Look at the wiki first." },
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_ls",
              type: "function",
              function: { name: "ls", arguments: '{"path":"/"}' },
            },
          ],
        },
      ],
      [
        { reasoning_content: "Nothing to change." },
        { role: "assistant", content: "Done." },
      ],
    ];
    const fetchStream: typeof fetch = () => {
      const id = `chatcmpl-${replies.length}`;
      const deltas = replies.shift() ?? [];
      const events = deltas.map((delta) => ({
        id,
        object: "chat.completion.chunk",
        created: 0,
        model: "glm-test",
        choices: [{ index: 0, delta, finish_reason: null }],
      }));
      const body = `${events
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("")}data: [DONE]\n\n`;
      return Promise.resolve(
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      );
    };
    const model = new ChatOpenAI({
      apiKey: "test-key",
      model: "glm-test",
      streaming: true,
      maxRetries: 0,
      configuration: { baseURL: "https://gateway.test/v1", fetch: fetchStream },
    });

    const agent = await createOpenWikiAgent({
      command: "update",
      cwd,
      model,
      outputMode: "local-wiki",
    });
    const result = (await agent.invoke(
      { messages: [{ role: "user", content: "Update the wiki." }] },
      { configurable: { thread_id: "roleless-first-delta" } },
    )) as { messages: BaseMessage[] };

    const replyMessages = result.messages.filter((message) =>
      AIMessage.isInstance(message),
    );
    expect(replyMessages.map(({ tool_calls }) => tool_calls)).toEqual([
      [
        expect.objectContaining({
          id: "call_ls",
          name: "ls",
          args: { path: "/" },
        }),
      ],
      [],
    ]);
    expect(replyMessages.at(-1)?.text).toBe("Done.");
    expect(replies).toHaveLength(0);
  });
});
