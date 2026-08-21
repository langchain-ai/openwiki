import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createDeepAgent } from "deepagents";
import { describe, expect, test } from "vitest";
import {
  applyGeneralPurposeGuard,
  createOpenWikiGeneralPurposeGuardMiddleware,
  readSubagentType,
  stripGeneralPurpose,
  type GuardableTaskTool,
} from "../../src/agent/general-purpose-guard.ts";

/** The task tool description DeepAgents renders, abridged to the lines that matter. */
const TASK_DESCRIPTION = [
  "Launch an ephemeral subagent to handle a complex, multi-step task.",
  "",
  "Available agent types and the tools they have access to:",
  "- general-purpose: General-purpose agent for researching complex questions.",
  "- page-author: Writes one assigned wiki page.",
  "",
  "Specify subagent_type to select the agent. Usage notes:",
  "- Each invocation is stateless.",
  "- When only general-purpose is available, use it for any complex task.",
].join("\n");

/** A stand-in task tool that records what reached the real dispatch. */
function stubTaskTool(): GuardableTaskTool & { dispatched: unknown[] } {
  const dispatched: unknown[] = [];
  return {
    dispatched,
    name: "task",
    description: TASK_DESCRIPTION,
    invoke: (input: unknown) => {
      dispatched.push(input);
      return Promise.resolve("dispatched");
    },
  };
}

/**
 * A chat model that replays a fixed script, so one turn can call a tool and the
 * next can end the run. The fakes in `@langchain/core` cannot: their `_generate`
 * always returns the first response, which turns a tool call into a loop.
 */
class ScriptedChatModel extends BaseChatModel {
  /** Tools from the most recent bind, as the agent assembled them. */
  bound: StructuredToolInterface[] = [];

  #turn = 0;

  constructor(private readonly script: AIMessage[]) {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  _combineLLMOutput() {
    return [];
  }

  bindTools(tools: StructuredToolInterface[]): this {
    this.bound = tools;
    return this;
  }

  _generate(): Promise<ChatResult> {
    const message = this.script[Math.min(this.#turn++, this.script.length - 1)];
    return Promise.resolve({ generations: [{ message, text: "" }] });
  }
}

/** A ToolMessage's text, whether it was stored as a string or content blocks. */
function contentText(message: ToolMessage | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? [])
    .map((block) =>
      typeof block === "object" && "text" in block ? block.text : "",
    )
    .join("");
}

/** Every ToolMessage the run produced, in order. */
function toolMessages(result: unknown): ToolMessage[] {
  const messages = (result as { messages?: unknown[] }).messages ?? [];
  return messages.filter((message): message is ToolMessage =>
    ToolMessage.isInstance(message),
  );
}

describe("general-purpose subagent guard", () => {
  test("strips general-purpose from the roster and the usage notes", () => {
    const stripped = stripGeneralPurpose(TASK_DESCRIPTION);

    expect(stripped).not.toContain("general-purpose");
    expect(stripped).toContain("- page-author: Writes one assigned wiki page.");
    expect(stripped).toContain("Available agent types");
    expect(stripped).toContain("- Each invocation is stateless.");
  });

  test("reads the subagent name and caller from both call shapes", () => {
    // ToolNode invokes with the tool call; the REPL bridge with the arguments.
    expect(
      readSubagentType({
        name: "task",
        args: { description: "d", subagent_type: "page-author" },
        id: "call-1",
        type: "tool_call",
      }),
    ).toEqual({ subagentType: "page-author", toolCallId: "call-1" });
    expect(
      readSubagentType({ description: "d", subagent_type: "page-author" }),
    ).toEqual({ subagentType: "page-author", toolCallId: undefined });
    expect(readSubagentType({ description: "d" })).toEqual({
      subagentType: undefined,
      toolCallId: undefined,
    });
    expect(readSubagentType("task")).toEqual({});
  });

  test("rejects a REPL dispatch of general-purpose rather than answering it", async () => {
    const taskTool = stubTaskTool();
    applyGeneralPurposeGuard(taskTool);

    // `@langchain/quickjs` invokes with the arguments directly and hands the
    // result to guest code, so a refusal has to reject: returned as a value it
    // would read as the subagent's own output.
    await expect(
      taskTool.invoke({
        description: "explore",
        subagent_type: "general-purpose",
      }),
    ).rejects.toThrow(/"general-purpose" subagent is not available/u);
    expect(taskTool.dispatched).toEqual([]);
  });

  test("answers a model tool call with an error message rather than throwing", async () => {
    const taskTool = stubTaskTool();
    applyGeneralPurposeGuard(taskTool);

    // Throwing here would end the run: ToolNode rethrows anything raised under
    // a wrapToolCall, which DeepAgents always installs.
    const refusal = (await taskTool.invoke({
      name: "task",
      args: { description: "explore", subagent_type: "general-purpose" },
      id: "call-1",
      type: "tool_call",
    })) as ToolMessage;

    expect(ToolMessage.isInstance(refusal)).toBe(true);
    expect(refusal.status).toBe("error");
    expect(refusal.tool_call_id).toBe("call-1");
    expect(contentText(refusal)).toContain(
      '"general-purpose" subagent is not available',
    );
    expect(taskTool.dispatched).toEqual([]);
  });

  test("passes every other subagent through untouched", async () => {
    const taskTool = stubTaskTool();
    applyGeneralPurposeGuard(taskTool);

    await expect(
      taskTool.invoke({ description: "write", subagent_type: "page-author" }),
    ).resolves.toBe("dispatched");
    await expect(
      taskTool.invoke({
        name: "task",
        args: { description: "write", subagent_type: "page-author" },
        id: "call-1",
        type: "tool_call",
      }),
    ).resolves.toBe("dispatched");
    expect(taskTool.dispatched).toHaveLength(2);
  });

  test("guards the registered task tool of a real agent", async () => {
    const model = new ScriptedChatModel([
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call-1",
            name: "task",
            args: {
              description: "explore the repo",
              subagent_type: "general-purpose",
            },
          },
        ],
      }),
      new AIMessage({ content: "done" }),
    ]);
    const agent = createDeepAgent({
      model,
      middleware: [createOpenWikiGeneralPurposeGuardMiddleware()],
      subagents: [
        {
          name: "page-author",
          description: "Writes one assigned wiki page.",
          systemPrompt: "Write the page.",
        },
      ],
    });

    const result = await agent.invoke({ messages: [new HumanMessage("go")] });

    // The model never sees it offered: the guard rewrote the description of the
    // same instance the agent binds.
    const boundTask = model.bound.find((tool) => tool.name === "task");
    expect(boundTask?.description).toBeDefined();
    expect(boundTask?.description).not.toContain("general-purpose");
    expect(boundTask?.description).toContain("page-author");

    // And the instance ToolNode executes is the guarded one, which is the whole
    // reason the patch is applied in place rather than to a copy.
    const refusal = toolMessages(result).find(
      (message) => message.name === "task",
    );
    expect(refusal?.status).toBe("error");
    expect(contentText(refusal)).toContain(
      '"general-purpose" subagent is not available',
    );
  });

  test("fails loudly when the task tool is absent", () => {
    const middleware = createOpenWikiGeneralPurposeGuardMiddleware();
    const wrapModelCall = middleware.wrapModelCall as (
      request: unknown,
      handler: (request: unknown) => unknown,
    ) => unknown;

    expect(() =>
      wrapModelCall({ tools: [{ name: "read_file" }] }, (request) => request),
    ).toThrow(/requires the subagent task tool/u);
  });
});
