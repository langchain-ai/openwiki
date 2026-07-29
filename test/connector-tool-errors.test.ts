import { DynamicStructuredTool } from "@langchain/core/tools";
import { describe, expect, test } from "vitest";

import {
  createOpenWikiConnectorTools,
  withToolErrorsAsResults,
} from "../src/connectors/tools.ts";

// The connector tools threw on error instead of returning the message as the
// tool result (issue #427). A thrown tool error aborts the agent run, and even
// when it doesn't, the model never sees the text — which matters because these
// messages are written *for* the model. `callMcpTool` answers a wrong tool name
// with "Run openwiki_list_mcp_tools first and use an exact discovered name",
// exactly the hint needed to retry, and the model never received it.
//
// Note on scope: schema violations are rejected by LangChain before `func` runs
// and are a different layer. These tests cover errors thrown *inside* the tool,
// which is what the issue is about.

function toolNamed(name: string) {
  const tool = createOpenWikiConnectorTools().find(
    (candidate) => candidate.name === name,
  );
  if (!tool) {
    throw new Error(`tool ${name} not registered`);
  }
  return tool;
}

describe("withToolErrorsAsResults", () => {
  test("a thrown Error becomes a labelled result", async () => {
    const tool = withToolErrorsAsResults(
      new DynamicStructuredTool({
        description: "d",
        func: () => {
          throw new Error("the model should read this");
        },
        name: "boom",
        schema: { additionalProperties: false, properties: {}, type: "object" },
      }),
    );

    await expect(tool.invoke({})).resolves.toBe(
      "Tool error: the model should read this",
    );
  });

  test("a rejected promise becomes a labelled result", async () => {
    const tool = withToolErrorsAsResults(
      new DynamicStructuredTool({
        description: "d",
        func: () => Promise.reject(new Error("async failure")),
        name: "boom-async",
        schema: { additionalProperties: false, properties: {}, type: "object" },
      }),
    );

    await expect(tool.invoke({})).resolves.toBe("Tool error: async failure");
  });

  test("a non-Error throw is still reported", async () => {
    const tool = withToolErrorsAsResults(
      new DynamicStructuredTool({
        description: "d",
        // A provider that rejects with a bare string, which the wrapper must
        // still report rather than losing.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        func: () => Promise.reject("rate limited"),
        name: "boom-string",
        schema: { additionalProperties: false, properties: {}, type: "object" },
      }),
    );

    await expect(tool.invoke({})).resolves.toBe("Tool error: rate limited");
  });

  test("a successful result passes through untouched", async () => {
    const tool = withToolErrorsAsResults(
      new DynamicStructuredTool({
        description: "d",
        func: () => Promise.resolve("real output"),
        name: "fine",
        schema: { additionalProperties: false, properties: {}, type: "object" },
      }),
    );

    await expect(tool.invoke({})).resolves.toBe("real output");
  });
});

describe("registered connector tools", () => {
  test("a wrong MCP tool name returns the self-correction hint instead of throwing", async () => {
    // The issue's headline case: the model guesses `notion-get-page-content`
    // instead of a discovered name. Schema-valid, so it reaches the tool body.
    const tool = toolNamed("openwiki_call_mcp_tool");

    const result = String(
      await tool.invoke({
        args: {},
        connectorId: "notion",
        toolName: "notion-get-page-content",
      }),
    );

    expect(result.startsWith("Tool error:")).toBe(true);
    expect(result.length).toBeGreaterThan("Tool error: ".length);
  });

  test("a successful connector tool call is unaffected", async () => {
    const result = String(await toolNamed("openwiki_list_connectors").invoke({}));

    expect(result).not.toContain("Tool error:");
    expect(() => JSON.parse(result) as unknown).not.toThrow();
  });
});
