import { webcrypto } from "node:crypto";
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    writable: true,
    configurable: true,
  });
}

import { createDeepAgent } from "deepagents";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as assert from "node:assert";

class SharedStateFakeChatModel extends BaseChatModel {
  static lc_name() {
    return "SharedStateFakeChatModel";
  }
  _llmType() {
    return "shared-state-fake";
  }

  private sharedState: { responses: Array<any>; i: number };

  constructor(sharedState: { responses: Array<any>; i: number }) {
    super({});
    this.sharedState = sharedState;
  }

  async _generate(messages: any, options: any) {
    const response = this.sharedState.responses[this.sharedState.i];
    console.log(`[Model Call] index=${this.sharedState.i}, returning:`, JSON.stringify(response));
    if (this.sharedState.i < this.sharedState.responses.length - 1) {
      this.sharedState.i++;
    } else {
      this.sharedState.i = 0;
    }
    return {
      generations: [
        {
          message: response instanceof AIMessage ? response : new AIMessage(response),
          text: typeof response === "string" ? response : response.content ?? "",
        },
      ],
      llmOutput: {},
    };
  }

  bindTools(tools: any) {
    const next = new SharedStateFakeChatModel(this.sharedState);
    return next;
  }
}

const addTool = tool(
  async ({ a, b }) => {
    return (a + b).toString();
  },
  {
    name: "add",
    description: "Add two numbers together",
    schema: z.object({
      a: z.number(),
      b: z.number(),
    }),
  }
);

async function runTests() {
  console.log("--- Running Main Agent Tool Validation Error Regression Test ---");
  {
    const sharedState = {
      i: 0,
      responses: [
        new AIMessage({
          content: "Calling add tool",
          tool_calls: [
            {
              name: "add",
              args: { a: "not-a-number", b: 2 },
              id: "call_1",
              type: "tool_call",
            },
          ],
        }),
        new AIMessage({
          content: "Successfully handled error.",
        }),
      ],
    };

    const model = new SharedStateFakeChatModel(sharedState);
    const agent = createDeepAgent({
      model,
      tools: [addTool],
      handleToolErrors: true,
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Add not-a-number and 2" }],
    });

    const messages = result.messages;
    console.log("Main agent run completed. Messages length:", messages.length);

    const toolMessages = messages.filter((m) => m instanceof ToolMessage);
    assert.strictEqual(toolMessages.length, 1, "Should have exactly 1 ToolMessage response");
    const errorMsg = toolMessages[0].content;
    console.log("Returned error message:", errorMsg);
    assert.ok(
      errorMsg.includes("Expected number") || errorMsg.includes("not-a-number") || errorMsg.includes("Error"),
      "ToolMessage should contain validation error message"
    );
    console.log("Main agent test passed!");
  }

  console.log("\n--- Running Subagent Tool Validation Error Regression Test ---");
  {
    const sharedState = {
      i: 0,
      responses: [
        // 1. Main agent delegates to calculator subagent
        new AIMessage({
          content: "Delegating math calculation.",
          tool_calls: [
            {
              name: "task",
              args: { description: "Add invalid numbers", subagent_type: "calculator" },
              id: "call_task_1",
              type: "tool_call",
            },
          ],
        }),
        // 2. Subagent calls the add tool with invalid args (and crashes due to lack of handleToolErrors on subagent)
        new AIMessage({
          content: "Calling add tool inside subagent.",
          tool_calls: [
            {
              name: "add",
              args: { a: "not-a-number", b: 2 },
              id: "call_add_1",
              type: "tool_call",
            },
          ],
        }),
        // 3. Main agent receives the error from the task tool and finishes
        new AIMessage({
          content: "The calculator subagent crashed, but I handled the error gracefully.",
        }),
      ],
    };

    const model = new SharedStateFakeChatModel(sharedState);
    const agent = createDeepAgent({
      model,
      tools: [],
      handleToolErrors: true,
      subagents: [
        {
          name: "calculator",
          description: "Performs math calculations",
          systemPrompt: "You are a math subagent.",
          tools: [addTool],
          model,
        },
      ],
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Ask calculator to add not-a-number and 2" }],
    });

    const messages = result.messages;
    console.log("Subagent run completed. Messages length:", messages.length);
    messages.forEach((msg: any, idx: number) => {
      console.log(`Message [${idx}] (${msg.constructor.name}):`, JSON.stringify(msg));
    });

    // Check that the task ToolMessage contains the validation error message from the subagent's crash
    const taskToolMsg = messages.find((m) => m instanceof ToolMessage && m.name === "task");
    assert.ok(taskToolMsg, "Should contain task ToolMessage");
    const errorMsg = taskToolMsg.content;
    console.log("Returned error message from subagent crash:", errorMsg);
    assert.ok(
      errorMsg.includes("Expected number") || errorMsg.includes("not-a-number") || errorMsg.includes("Error"),
      "Subagent error output should be captured by task ToolMessage"
    );

    const finalMsg = messages[messages.length - 1].content;
    console.log("Final message:", finalMsg);
    assert.strictEqual(
      finalMsg,
      "The calculator subagent crashed, but I handled the error gracefully.",
      "Should have returned the correct final answer"
    );
    console.log("Subagent test passed!");
  }

  console.log("\nAll regression tests passed successfully!");
}

runTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
