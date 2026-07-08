import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { createDeepAgent, LocalShellBackend } from "deepagents";
import { describe, expect, it } from "vitest";
import { createToolSchemaRecoveryMiddleware } from "../src/agent/tool-recovery.ts";

/**
 * Minimal chat model that replays a fixed script of AI responses. The agent
 * binds real tools to it (which it ignores); the scripted responses drive the
 * tool calls, letting us reproduce a malformed call deterministically with no
 * network/model access.
 */
class ScriptedChatModel extends BaseChatModel {
  private readonly responses: AIMessage[];

  callCount = 0;

  constructor(responses: AIMessage[]) {
    super({});
    this.responses = responses;
  }

  _llmType(): string {
    return "scripted";
  }

  // deepagents calls bindTools(); we drive tool calls via the script instead.
  override bindTools(): this {
    return this;
  }

  _generate(): Promise<ChatResult> {
    const message =
      this.responses[Math.min(this.callCount, this.responses.length - 1)];
    this.callCount += 1;
    const text = typeof message.content === "string" ? message.content : "";

    return Promise.resolve({ generations: [{ text, message }] });
  }
}

function malformedWriteFileTurn(): AIMessage {
  // write_file requires file_path/content; empty args fail schema validation.
  return new AIMessage({
    content: "",
    tool_calls: [
      { name: "write_file", args: {}, id: "call_bad", type: "tool_call" },
    ],
  });
}

async function buildAgent(withRecovery: boolean, model: ScriptedChatModel) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-toolrec-"));

  return createDeepAgent({
    model,
    tools: [],
    backend: new LocalShellBackend({ rootDir, virtualMode: true }),
    ...(withRecovery
      ? { middleware: [createToolSchemaRecoveryMiddleware()] }
      : {}),
  });
}

const userTurn = {
  messages: [{ role: "user" as const, content: "Generate docs." }],
};
const invokeConfig = { recursionLimit: 8 };

describe("tool schema recovery middleware (integration)", () => {
  it("WITHOUT the middleware, a malformed tool call aborts the run", async () => {
    const model = new ScriptedChatModel([
      malformedWriteFileTurn(),
      new AIMessage({ content: "Done." }),
    ]);
    const agent = await buildAgent(false, model);

    await expect(agent.invoke(userTurn, invokeConfig)).rejects.toThrow();
  });

  it("WITH the middleware, the malformed call becomes an error ToolMessage and the run continues", async () => {
    const model = new ScriptedChatModel([
      malformedWriteFileTurn(),
      new AIMessage({ content: "Done." }),
    ]);
    const agent = await buildAgent(true, model);

    const result = await agent.invoke(userTurn, invokeConfig);
    const messages = result.messages as BaseMessage[];

    // The run reached the model a second time (it retried after the error).
    expect(model.callCount).toBeGreaterThanOrEqual(2);

    // A recovery ToolMessage was fed back for the bad write_file call.
    const toolMessage = messages.find(
      (message): message is ToolMessage =>
        ToolMessage.isInstance(message) && message.tool_call_id === "call_bad",
    );
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.status).toBe("error");
    expect(toolMessage?.content).toContain("write_file");

    // The loop completed with the model's final answer.
    const finalAnswer = messages.at(-1);
    expect(finalAnswer && AIMessage.isInstance(finalAnswer)).toBe(true);
    expect(finalAnswer?.content).toContain("Done.");
  });
});
