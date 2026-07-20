import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Captures how AnthropicVertex is constructed on the gemini-enterprise Claude
// surface: which projectId/region it receives, and — critically — whether the
// ANTHROPIC_* env vars are neutralized at construction time (so the base
// Anthropic SDK can't send them as an Authorization header that clobbers the
// Google OAuth token).
type VertexCall = {
  options: { projectId?: string; region?: string };
  anthropicApiKeyVisible: boolean;
  anthropicAuthTokenVisible: boolean;
};

const vertexCalls: VertexCall[] = [];

vi.mock("@anthropic-ai/vertex-sdk", () => ({
  AnthropicVertex: class {
    constructor(options: { projectId?: string; region?: string }) {
      vertexCalls.push({
        options,
        anthropicApiKeyVisible: process.env.ANTHROPIC_API_KEY !== undefined,
        anthropicAuthTokenVisible:
          process.env.ANTHROPIC_AUTH_TOKEN !== undefined,
      });
    }
  },
}));

const { createModel } = await import("../src/agent/index.ts");

const PROJECT_KEY = "GOOGLE_CLOUD_PROJECT";
const LOCATION_KEY = "GOOGLE_CLOUD_LOCATION";

describe("gemini-enterprise Claude surface (createClient)", () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {
      [PROJECT_KEY]: process.env[PROJECT_KEY],
      [LOCATION_KEY]: process.env[LOCATION_KEY],
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    };
    process.env[PROJECT_KEY] = "test-project";
    process.env[LOCATION_KEY] = "us-east5";
    process.env.ANTHROPIC_API_KEY = "sk-should-be-hidden";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-should-be-hidden";
    vertexCalls.length = 0;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("neutralizes ANTHROPIC_* env vars around AnthropicVertex construction and passes project/region", () => {
    const model = createModel(
      "gemini-enterprise",
      "publishers/anthropic/models/claude-sonnet-4-5@20250929",
      0,
    );

    // createClient is lazy — invoke it to trigger AnthropicVertex construction.
    const client = (model as { createClient?: () => unknown }).createClient?.();
    expect(client).toBeDefined();

    expect(vertexCalls).toHaveLength(1);
    const call = vertexCalls[0];
    // The env vars must have been hidden while the client was constructed.
    expect(call?.anthropicApiKeyVisible).toBe(false);
    expect(call?.anthropicAuthTokenVisible).toBe(false);
    // Project + region flow through.
    expect(call?.options.projectId).toBe("test-project");
    expect(call?.options.region).toBe("us-east5");
  });

  test("restores ANTHROPIC_* env vars after construction", () => {
    const model = createModel(
      "gemini-enterprise",
      "publishers/anthropic/models/claude-sonnet-4-5@20250929",
      0,
    );
    (model as { createClient?: () => unknown }).createClient?.();

    // Restored to the values set in beforeEach.
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-should-be-hidden");
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("tok-should-be-hidden");
  });
});
