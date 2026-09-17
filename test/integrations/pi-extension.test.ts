import { describe, expect, test } from "vitest";

type RegisteredTool = {
  name: string;
  executionMode?: "sequential" | "parallel";
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

type Extension = (pi: {
  registerTool(tool: RegisteredTool): void;
  on(event: string, handler: () => Promise<void>): void;
}) => void;

const extension: Extension = (
  await import("../../dist/integrations/pi/openwiki.js")
).default;

type Schema = Record<string, unknown>;

type ExtensionHarness = {
  tools: Map<string, RegisteredTool>;
  shutdown: (() => Promise<void>) | undefined;
};

function createHarness(): ExtensionHarness {
  const harness: ExtensionHarness = {
    tools: new Map(),
    shutdown: undefined,
  };
  extension({
    registerTool(tool: RegisteredTool) {
      harness.tools.set(tool.name, tool);
    },
    on(event: string, handler: () => Promise<void>) {
      if (event === "session_shutdown") harness.shutdown = handler;
    },
  });
  return harness;
}

describe("native Pi package extension", () => {
  test("registers exactly the canonical OpenWiki tools", () => {
    const harness = createHarness();
    expect([...harness.tools.keys()]).toEqual([
      "openwiki_begin",
      "openwiki_submit_plan",
      "openwiki_next_page",
      "openwiki_inspect_page_claims",
      "openwiki_submit_page",
      "openwiki_finish",
    ]);
    expect(
      [...harness.tools.values()].map((tool) => tool.executionMode),
    ).toEqual(Array(6).fill("sequential"));
  });

  test("publishes strict nested protocol schemas", () => {
    const harness = createHarness();
    const plan = harness.tools.get("openwiki_submit_plan")!;
    const planParameters = plan.parameters as {
      properties: Record<string, Schema>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(planParameters).toMatchObject({
      required: ["runId", "pages"],
      additionalProperties: false,
    });
    expect(planParameters.properties.runId).toMatchObject({
      type: "string",
      format: "uuid",
    });
    expect(planParameters.properties.pages).toMatchObject({
      type: "array",
    });
    const pageSchema = planParameters.properties.pages.items as Schema;
    expect(pageSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(pageSchema.properties).toMatchObject({
      path: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      purpose: { type: "string", minLength: 1 },
    });

    const submit = harness.tools.get("openwiki_submit_page")!;
    const submitParameters = submit.parameters as {
      properties: Record<string, Schema>;
    };
    const claimSchema = submitParameters.properties.claims.items as Schema;
    expect(claimSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    const claimProperties = claimSchema.properties as Record<string, Schema>;
    expect(claimProperties.statement).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(claimProperties.evidence).toMatchObject({
      type: "array",
      minItems: 1,
    });
  });

  test("starts MCP lazily, forwards validation errors, and shuts down", async () => {
    const harness = createHarness();
    const begin = harness.tools.get("openwiki_begin");
    expect(begin).toBeDefined();

    await expect(begin!.execute("invalid-input", {})).rejects.toThrow(
      /invalid|argument|schema/i,
    );
    expect(harness.shutdown).toBeDefined();
    await expect(harness.shutdown!()).resolves.toBeUndefined();
  }, 20_000);
});
