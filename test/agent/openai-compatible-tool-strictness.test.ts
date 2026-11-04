import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ChatOpenAI } from "@langchain/openai";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createModel } from "../../src/agent/index.js";

const claimTool = new DynamicStructuredTool({
  name: "submit_page",
  description: "Submit sparse Claim decisions for a page.",
  schema: z
    .object({
      claims: z
        .array(
          z
            .object({
              id: z.string().optional(),
              statement: z.string(),
              evidence: z.array(z.object({ resource: z.string() }).strict()),
            })
            .strict(),
        )
        .optional(),
    })
    .strict(),
  func: (input) => Promise.resolve(JSON.stringify(input)),
});

const requiredTool = new DynamicStructuredTool({
  name: "required_only",
  description: "A tool with no optional fields.",
  schema: z.object({ statement: z.string() }).strict(),
  func: (input) => Promise.resolve(JSON.stringify(input)),
});

type WireTool = {
  strict?: boolean | null;
  parameters?: { required?: string[]; properties?: Record<string, unknown> };
  function?: {
    strict?: boolean;
    parameters?: { required?: string[]; properties?: Record<string, unknown> };
  };
};

async function captureToolRequest(
  useResponsesApi: boolean,
  tool: DynamicStructuredTool,
  strict?: boolean,
): Promise<{ path: string; tool: WireTool }> {
  const requests: Array<{ path: string; tools: WireTool[] }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body) as { tools: WireTool[] };
      requests.push({ path: request.url ?? "", tools: payload.tools });
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "request captured", type: "invalid_request_error" },
        }),
      );
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "mock-only");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", `http://127.0.0.1:${port}/v1`);
    vi.stubEnv("OPENWIKI_OPENAI_COMPATIBLE_STREAMING", "false");
    vi.stubEnv(
      "OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API",
      String(useResponsesApi),
    );
    const model = createModel("openai-compatible", "local-model", 0);
    await expect(
      model
        .bindTools([tool], strict === undefined ? undefined : { strict })
        .invoke("Capture the request."),
    ).rejects.toThrow("request captured");

    expect(requests).toHaveLength(1);
    const request = requests[0];
    const wireTool = request?.tools.find(
      (candidate) => candidate.function?.parameters ?? candidate.parameters,
    );
    if (!request || !wireTool) throw new Error("Function tool was not sent.");
    return { path: request.path, tool: wireTool };
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

afterEach(() => vi.unstubAllEnvs());

describe("OpenAI-compatible function tool strictness", () => {
  test.each([
    [false, "/v1/chat/completions"],
    [true, "/v1/responses"],
  ])("preserves optional Claim id on %s transport", async (responses, path) => {
    const captured = await captureToolRequest(responses, claimTool);
    expect(captured.path).toBe(path);
    const functionTool = captured.tool.function ?? captured.tool;
    expect(functionTool.strict).toBe(false);
    const claims = functionTool.parameters?.properties?.claims as {
      items: { properties: { id: unknown }; required: string[] };
    };
    expect(claims.items.properties.id).toBeDefined();
    expect(claims.items.required).toEqual(["statement", "evidence"]);
  });

  test.each([false, true])(
    "keeps an explicit strict override on Responses=%s",
    async (responses) => {
      const captured = await captureToolRequest(responses, claimTool, true);
      expect((captured.tool.function ?? captured.tool).strict).toBe(true);
    },
  );

  test("preserves required fields on a tool without optional fields", async () => {
    const captured = await captureToolRequest(false, requiredTool);
    expect(
      (captured.tool.function ?? captured.tool).parameters?.required,
    ).toEqual(["statement"]);
  });

  test("does not change the OpenAI provider default", () => {
    vi.stubEnv("OPENAI_API_KEY", "mock-only");
    const model = createModel("openai", "gpt-5.5", 0);
    expect(model).toBeInstanceOf(ChatOpenAI);
    expect((model as ChatOpenAI).supportsStrictToolCalling).toBeUndefined();
  });

  test("accepts a new Claim without an id", async () => {
    await expect(
      claimTool.invoke({
        claims: [
          {
            statement: "The page has a grounded fact.",
            evidence: [{ resource: "repo://README.md" }],
          },
        ],
      }),
    ).resolves.toContain('"statement":"The page has a grounded fact."');
  });
});
