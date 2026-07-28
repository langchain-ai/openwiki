import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildChildEnv,
  executeMcpReadOnlyOperations,
  executeMcpTool,
  listMcpTools,
} from "../../src/connectors/mcp-client.ts";

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

// The three exported entry points validate the untrusted connector config
// BEFORE they ever spawn a subprocess or open a network transport. Every case
// below asserts a rejection that happens during that pre-flight validation, so
// none of them actually run an MCP server. This is the pure, spawn-free surface;
// the accept paths that follow validation (a well-formed command that is then
// executed, a reachable https URL that is then contacted) are intentionally left
// for integration tests and are documented in the report.

/**
 * A minimal valid tool operation so config-level validation passes and control
 * reaches the transport-specific command/URL checks we want to exercise.
 */
const VALID_TOOL_OP = { name: "search", type: "tool" as const };

describe("executeMcpTool input validation", () => {
  test("rejects a config with no transport before dispatching", async () => {
    // A missing transport is the first guard; without it there is nothing safe
    // to spawn or connect to, so execution must never proceed.
    await expect(executeMcpTool({}, "search", {})).rejects.toThrow(
      /requires a transport/u,
    );
  });

  test("rejects an operation name outside the allowed character set", async () => {
    // Tool names are attacker-influenced (they come from config/model output);
    // anything with shell/JSON-RPC metacharacters is refused before a call.
    await expect(
      executeMcpTool(
        { transport: { type: "stdio", command: "notion-mcp" } },
        "bad name; rm -rf /",
        {},
      ),
    ).rejects.toThrow(/Invalid MCP operation name/u);
  });

  test("rejects an argument key outside the allowed character set", async () => {
    // A valid name here proves the name allowlist ACCEPTED it (validation only
    // reaches the arg check after the name passes); the malformed arg key is
    // what triggers the rejection, guarding against injected argument names.
    await expect(
      executeMcpTool(
        { transport: { type: "stdio", command: "notion-mcp" } },
        "search",
        { "bad key!": "x" },
      ),
    ).rejects.toThrow(/Invalid MCP tool argument name/u);
  });
});

describe("executeMcpReadOnlyOperations config validation", () => {
  test("rejects when transport is missing", async () => {
    await expect(
      executeMcpReadOnlyOperations({
        readOnlyOperations: [VALID_TOOL_OP],
      }),
    ).rejects.toThrow(/requires a transport/u);
  });

  test("rejects when readOnlyOperations is empty", async () => {
    await expect(
      executeMcpReadOnlyOperations({
        transport: { type: "stdio", command: "notion-mcp" },
        readOnlyOperations: [],
      }),
    ).rejects.toThrow(/at least one readOnlyOperation/u);
  });

  test("rejects an unknown operation type", async () => {
    await expect(
      executeMcpReadOnlyOperations({
        transport: { type: "stdio", command: "notion-mcp" },
        readOnlyOperations: [{ name: "search", type: "delete" as never }],
      }),
    ).rejects.toThrow(/Invalid MCP operation type/u);
  });

  test("rejects a resource operation with no resolvable URI", async () => {
    // A resource op needs a scheme-qualified URI in name or args.uri; an empty
    // name with no args.uri is rejected rather than guessed at.
    await expect(
      executeMcpReadOnlyOperations({
        transport: { type: "stdio", command: "notion-mcp" },
        readOnlyOperations: [{ name: "", type: "resource" }],
      }),
    ).rejects.toThrow(/requires a resource URI/u);
  });

  test("rejects a resource URI without a valid scheme", async () => {
    // Only scheme-qualified URIs (foo:...) are allowed; a bare/relative path is
    // refused so a resource read cannot be pointed at arbitrary local content.
    await expect(
      executeMcpReadOnlyOperations({
        transport: { type: "stdio", command: "notion-mcp" },
        readOnlyOperations: [{ name: "../../etc/passwd", type: "resource" }],
      }),
    ).rejects.toThrow(/Invalid MCP resource URI/u);
  });
});

describe("stdio command allowlist", () => {
  test("rejects a command containing shell metacharacters", async () => {
    // Even though the subprocess is spawned with shell:false, the command
    // string is still validated against a strict allowlist regex so a
    // config-supplied command cannot smuggle in spaces/operators.
    await expect(
      executeMcpReadOnlyOperations({
        transport: { type: "stdio", command: "notion-mcp; rm -rf /" },
        readOnlyOperations: [VALID_TOOL_OP],
      }),
    ).rejects.toThrow(/Invalid MCP stdio command/u);
  });

  test("accepts a well-formed command and rejects only on a control-char arg", async () => {
    // The ACCEPT path of the command allowlist: "notion-mcp" is well-formed, so
    // validation moves past the command check to the per-arg check. The newline
    // in the arg is what fails here, which proves the command itself was
    // accepted by the allowlist without the process ever being spawned.
    await expect(
      executeMcpReadOnlyOperations({
        transport: {
          type: "stdio",
          command: "notion-mcp",
          args: ["--ok", "line1\nline2"],
        },
        readOnlyOperations: [VALID_TOOL_OP],
      }),
    ).rejects.toThrow(/must not contain control characters/u);
  });
});

describe("http URL allowlist", () => {
  test("rejects an http URL that is not localhost", async () => {
    // Remote MCP endpoints must be https; plain http to a non-loopback host is
    // refused so credentials/headers are never sent over a cleartext channel.
    await expect(
      executeMcpReadOnlyOperations({
        transport: { type: "http", url: "http://example.com/mcp" },
        readOnlyOperations: [VALID_TOOL_OP],
      }),
    ).rejects.toThrow(/must use https/u);
  });

  test("rejects a non-http(s) protocol", async () => {
    await expect(
      executeMcpReadOnlyOperations({
        transport: { type: "http", url: "ftp://example.com/mcp" },
        readOnlyOperations: [VALID_TOOL_OP],
      }),
    ).rejects.toThrow(/must use https/u);
  });

  test("rejects a malformed URL", async () => {
    // A string that is not a parseable URL fails in the URL constructor before
    // any network attempt.
    await expect(
      executeMcpReadOnlyOperations({
        transport: { type: "http", url: "not a url" },
        readOnlyOperations: [VALID_TOOL_OP],
      }),
    ).rejects.toThrow();
  });

  test("rejects an http transport with no URL", async () => {
    await expect(
      executeMcpReadOnlyOperations({
        transport: { type: "http" },
        readOnlyOperations: [VALID_TOOL_OP],
      }),
    ).rejects.toThrow(/requires a URL/u);
  });
});

describe("listMcpTools transport validation", () => {
  test("rejects when no transport is configured", async () => {
    await expect(listMcpTools({})).rejects.toThrow(/requires a transport/u);
  });

  test("rejects an http listing with no URL before connecting", async () => {
    await expect(listMcpTools({ transport: { type: "http" } })).rejects.toThrow(
      /requires a URL/u,
    );
  });

  test("rejects a stdio listing with an invalid command before spawning", async () => {
    await expect(
      listMcpTools({ transport: { type: "stdio", command: "bad command" } }),
    ).rejects.toThrow(/Invalid MCP stdio command/u);
  });
});
