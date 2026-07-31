import { describe, expect, test } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod/v3";
import { ChatClaudeCode } from "../src/agent/claude-code-model.ts";
import {
  createToolPermissionHandler,
  type CapturedToolCall,
  claudeCodeSessionEnv,
  isExpectedTurnEnding,
  jsonSchemaToZod,
  normalizeTool,
  normalizeToJsonSchema,
} from "../src/agent/claude-code-model.ts";

describe("JSON Schema to Zod conversion", () => {
  test("preserves required vs optional fields", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });

    expect(schema.safeParse({ a: "x" }).success).toBe(true);
    expect(schema.safeParse({ b: 1 }).success).toBe(false);
  });

  test("keeps an additionalProperties:true object open", () => {
    // openwiki_call_mcp_tool forwards arbitrary connector arguments through an
    // open `args` object. Closing it would strip every argument the model
    // sends, silently breaking connector ingestion.
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {},
      additionalProperties: true,
    });

    const parsed = schema.safeParse({ query: "Applied AI", limit: 5 });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ query: "Applied AI", limit: 5 });
  });

  test("closes an object that explicitly declares fields", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { known: { type: "string" } },
      required: ["known"],
      additionalProperties: false,
    });

    const parsed = schema.safeParse({ known: "x", extra: "dropped" });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ known: "x" });
  });

  test("converts arrays, enums, and nested objects", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: ["todo", "done"] },
        nested: {
          type: "object",
          properties: { n: { type: "integer" } },
          required: ["n"],
        },
      },
      required: ["items", "status", "nested"],
    });

    expect(
      schema.safeParse({
        items: ["a"],
        status: "todo",
        nested: { n: 1 },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ items: ["a"], status: "nope", nested: { n: 1 } })
        .success,
    ).toBe(false);
  });
});

describe("tool schema normalization", () => {
  test("converts a Zod v4 tool schema without losing parameters", () => {
    const jsonSchema = normalizeToJsonSchema(
      z.object({ todos: z.array(z.string()) }),
    ) as { properties?: Record<string, unknown> };

    expect(Object.keys(jsonSchema.properties ?? {})).toContain("todos");
  });

  test("converts a Zod v3 tool schema without losing parameters", () => {
    // DeepAgents tools are not uniformly Zod v4. Zod 4's own `toJSONSchema`
    // throws on a v3 schema, which previously degraded the tool to a
    // parameterless one — the model could still call it, but never correctly.
    const jsonSchema = normalizeToJsonSchema(
      z3.object({ todos: z3.array(z3.string()) }),
    ) as { properties?: Record<string, unknown> };

    expect(Object.keys(jsonSchema.properties ?? {})).toContain("todos");
  });

  test("reads OpenAI-style function tool definitions", () => {
    expect(
      normalizeTool({
        type: "function",
        function: {
          name: "write_file",
          description: "Write a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      }),
    ).toMatchObject({ name: "write_file", description: "Write a file" });
  });
});

describe("bindTools", () => {
  test("returns a new model without mutating the receiver", () => {
    const model = new ChatClaudeCode({ model: "claude-sonnet-5" });
    const bound = model.bindTools([
      { name: "ls", description: "List", schema: z.object({}) },
    ]);

    expect(bound).not.toBe(model);
    // DeepAgents rebinds per node; a mutating bindTools would leak one node's
    // tools into every later call.
    expect(model.bindTools([]).constructor).toBe(ChatClaudeCode);
  });
});

describe("session environment", () => {
  test("strips Anthropic credentials that would shadow the CLI session", () => {
    // OpenWiki loads ~/.openwiki/.env into process.env, so a previously
    // configured API key would otherwise bill the API — and fail outright when
    // that dead key is the reason the user chose this provider.
    const env = claudeCodeSessionEnv({
      ANTHROPIC_API_KEY: "sk-ant-dead",
      ANTHROPIC_AUTH_TOKEN: "oauth",
      ANTHROPIC_BASE_URL: "https://gateway.example.com",
      PATH: "/usr/bin",
    });

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("built-in tool refusal", () => {
  test("refuses a built-in without interrupting so the model can retry", async () => {
    // Regression: interrupting on a built-in ended the turn with nothing
    // captured, surfacing as error_max_turns and failing the whole run. Only an
    // OpenWiki tool call may interrupt; a built-in must be refused in a way the
    // model can recover from within the same turn.
    const captured: CapturedToolCall[] = [];
    const canUseTool = createToolPermissionHandler(captured);

    const builtin = await canUseTool("Read", { file_path: "/etc/passwd" });
    expect(builtin.behavior).toBe("deny");
    expect("interrupt" in builtin && builtin.interrupt).toBeFalsy();

    const openWikiTool = await canUseTool("mcp__openwiki__write_file", {
      file_path: "a.md",
    });
    expect(openWikiTool.behavior).toBe("deny");
    expect("interrupt" in openWikiTool && openWikiTool.interrupt).toBe(true);
    expect(captured).toEqual([
      { name: "write_file", args: { file_path: "a.md" } },
    ]);
  });
});

describe("turn ending classification", () => {
  test("treats a captured tool call as the expected interrupt", () => {
    expect(isExpectedTurnEnding("error_during_execution", 1)).toBe(true);
  });

  test("accepts a text-only turn that exhausted the turn cap", () => {
    expect(isExpectedTurnEnding("error_max_turns", 0)).toBe(true);
  });

  test("rejects a genuine failure with nothing captured", () => {
    // Billing/auth/transport failures must not be reported to the agent loop
    // as a usable turn, or a truncated section is baked into the wiki.
    expect(isExpectedTurnEnding("error_during_execution", 0)).toBe(false);
    expect(isExpectedTurnEnding(undefined, 0)).toBe(false);
  });
});
