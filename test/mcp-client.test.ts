import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildChildEnv } from "../src/connectors/mcp-client.ts";

describe("buildChildEnv", () => {
  const SECRET_KEYS = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "TAVILY_API_KEY",
    "SLACK_CLIENT_SECRET",
    "GMAIL_ACCESS_TOKEN",
    "X_REFRESH_TOKEN",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [...SECRET_KEYS, "PATH", "MCP_SERVER_TOKEN"]) {
      saved[key] = process.env[key];
    }
    for (const key of SECRET_KEYS) {
      process.env[key] = `secret-value-for-${key}`;
    }
    process.env.PATH = "/usr/bin:/bin";
    process.env.MCP_SERVER_TOKEN = "declared-token-123";
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

  test("does not forward OpenWiki credentials to the child env", () => {
    const childEnv = buildChildEnv({});
    for (const key of SECRET_KEYS) {
      expect(childEnv).not.toHaveProperty(key);
    }
    // A random full-process.env secret must never leak by value either.
    expect(Object.values(childEnv)).not.toContain(
      "secret-value-for-ANTHROPIC_API_KEY",
    );
  });

  test("passes through allow-listed base variables like PATH", () => {
    const childEnv = buildChildEnv({});
    expect(childEnv.PATH).toBe("/usr/bin:/bin");
  });

  test("resolves only the credentials the transport explicitly declares", () => {
    const childEnv = buildChildEnv({ MCP_TOKEN: "${MCP_SERVER_TOKEN}" });
    expect(childEnv.MCP_TOKEN).toBe("declared-token-123");
    // The source var name itself is not exposed, only the mapped target var.
    expect(childEnv).not.toHaveProperty("MCP_SERVER_TOKEN");
  });

  test("throws for an unresolvable declared reference", () => {
    expect(() => buildChildEnv({ MCP_TOKEN: "${DOES_NOT_EXIST}" })).toThrow(
      /DOES_NOT_EXIST is required/u,
    );
  });

  test("rejects invalid child env key names", () => {
    expect(() => buildChildEnv({ "bad-key": "${PATH}" })).toThrow(
      /Invalid env var reference/u,
    );
  });
});
