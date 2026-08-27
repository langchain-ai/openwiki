import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  buildChildEnv,
  executeMcpReadOnlyOperations,
  executeMcpTool,
  listMcpTools,
} from "../../src/connectors/mcp-client.ts";

// The stdio transport spawns a real subprocess. Mocking node:child_process lets
// us drive the JSON-RPC framing (initialize -> list/call -> response) entirely
// in-process, so no test ever forks a child or races on real I/O.
vi.mock("node:child_process");

const spawnMock = vi.mocked(spawn);

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
    for (const key of [
      ...SECRET_KEYS,
      "PATH",
      "APPDATA",
      "LOCALAPPDATA",
      "MCP_SERVER_TOKEN",
    ]) {
      saved[key] = process.env[key];
    }
    for (const key of SECRET_KEYS) {
      process.env[key] = `secret-value-for-${key}`;
    }
    process.env.PATH = "/usr/bin:/bin";
    process.env.APPDATA = "C:\\Users\\example\\AppData\\Roaming";
    process.env.LOCALAPPDATA = "C:\\Users\\example\\AppData\\Local";
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

  test("passes through Windows AppData paths used by many MCP servers", () => {
    const childEnv = buildChildEnv({});
    expect(childEnv.APPDATA).toBe("C:\\Users\\example\\AppData\\Roaming");
    expect(childEnv.LOCALAPPDATA).toBe("C:\\Users\\example\\AppData\\Local");
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

// ---------------------------------------------------------------------------
// Transport layer: stdio (mocked subprocess) and http (stubbed fetch).
// ---------------------------------------------------------------------------

/**
 * A fake ChildProcessWithoutNullStreams that speaks just enough of the shape
 * StdioJsonRpcClient touches: a capturing stdin, a pushable stdout, and the
 * error/exit event registration. `onRequest` receives each parsed JSON-RPC
 * frame the client writes and an `api` it uses to emit response frames back on
 * stdout (or to fire lifecycle events), so a whole round-trip runs synchronously
 * without a real process.
 */
interface FakeChildApi {
  /** Emit a JSON-RPC object as a single newline-framed stdout line. */
  emit: (frame: unknown) => void;

  /** Emit an arbitrary raw stdout chunk (for malformed-frame tests). */
  emitRaw: (chunk: string) => void;

  /** Fire a child lifecycle event ("error" | "exit") the client subscribed to. */
  fireChild: (event: string, ...args: unknown[]) => void;

  /** Fire a stderr "data" chunk to exercise the swallow-stderr handler. */
  fireStderr: (chunk: string) => void;
}

interface FakeChildHarness {
  child: ChildProcessWithoutNullStreams;

  /** Every string written to the child's stdin, in order. */
  writes: string[];

  api: FakeChildApi;
}

/**
 * Builds the fake child. Responses are emitted synchronously from inside
 * stdin.write: StdioJsonRpcClient.request() registers its pending entry BEFORE
 * it writes, so a same-tick stdout frame resolves the already-registered
 * promise deterministically, with no timers or microtask juggling.
 */
function makeFakeChild(
  onRequest: (
    frame: { id?: number; method?: string },
    api: FakeChildApi,
  ) => void,
): FakeChildHarness {
  const stdoutHandlers: Record<string, (chunk: string) => void> = {};
  const stderrHandlers: Record<string, (chunk: string) => void> = {};
  const childHandlers: Record<string, (...args: unknown[]) => void> = {};
  const writes: string[] = [];

  const api: FakeChildApi = {
    emit: (frame) => stdoutHandlers.data?.(`${JSON.stringify(frame)}\n`),
    emitRaw: (chunk) => stdoutHandlers.data?.(chunk),
    fireChild: (event, ...args) => childHandlers[event]?.(...args),
    fireStderr: (chunk) => stderrHandlers.data?.(chunk),
  };

  const child = {
    stdin: {
      write: (data: string) => {
        writes.push(String(data));
        const frame = JSON.parse(String(data).trim()) as {
          id?: number;
          method?: string;
        };
        onRequest(frame, api);
      },
      end: () => undefined,
    },
    stdout: {
      setEncoding: () => undefined,
      on: (event: string, cb: (chunk: string) => void) => {
        stdoutHandlers[event] = cb;
      },
    },
    stderr: {
      on: (event: string, cb: (chunk: string) => void) => {
        stderrHandlers[event] = cb;
      },
    },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      childHandlers[event] = cb;
    },
    kill: () => undefined,
    exitCode: null,
  };

  return {
    child: child as unknown as ChildProcessWithoutNullStreams,
    writes,
    api,
  };
}

/** Default JSON-RPC result payloads keyed by the method the client invokes. */
function defaultResultFor(method: string | undefined): unknown {
  switch (method) {
    case "tools/list":
      return {
        tools: [
          {
            name: "search",
            description: "Search the workspace",
            inputSchema: { type: "object" },
            annotations: { readOnly: true },
          },
        ],
      };
    case "tools/call":
      return { content: [{ type: "text", text: "ok" }] };
    case "resources/read":
      return { contents: [{ uri: "doc://readme", text: "hello" }] };
    default:
      return {};
  }
}

/**
 * A responder that answers every request with a standard success frame. This is
 * the happy-path JSON-RPC framing: match the id the client sent so the correct
 * pending promise resolves.
 */
function respondOk(
  frame: { id?: number; method?: string },
  api: FakeChildApi,
): void {
  if (frame.id === undefined) {
    // Notifications (e.g. notifications/initialized) carry no id and expect no
    // reply; answering one would be a protocol violation.
    return;
  }
  api.emit({
    jsonrpc: "2.0",
    id: frame.id,
    result: defaultResultFor(frame.method),
  });
}

describe("stdio MCP transport (mocked subprocess)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("runs a full initialize -> tool/resource round trip over stdio", async () => {
    const harness = makeFakeChild(respondOk);
    spawnMock.mockReturnValue(harness.child);

    const result = await executeMcpReadOnlyOperations({
      transport: {
        type: "stdio",
        command: "notion-mcp",
        args: ["--flag", "value"],
      },
      readOnlyOperations: [
        { name: "search", type: "tool", args: { q: "hi" } },
        { name: "doc://readme", type: "resource" },
      ],
    });

    // The subprocess is launched with an explicit argv array and shell:false so
    // no arg can be reinterpreted by a shell (argv-injection safety).
    expect(spawnMock).toHaveBeenCalledWith(
      "notion-mcp",
      ["--flag", "value"],
      expect.objectContaining({
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );

    // The tool op and the resource op both round-tripped and carried their
    // results back through executeOperation.
    expect(result.transport).toEqual({ command: "notion-mcp", type: "stdio" });
    expect(result.operations).toHaveLength(2);
    expect(result.operations[0]).toMatchObject({
      name: "search",
      type: "tool",
    });
    expect(result.operations[1]).toMatchObject({
      name: "doc://readme",
      type: "resource",
    });

    // The first frame the client ever writes must be a well-formed initialize
    // request; the framing (jsonrpc/method/id) is what the server keys on.
    const firstFrame = JSON.parse(harness.writes[0].trim()) as Record<
      string,
      unknown
    >;
    expect(firstFrame).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
    });
  });

  test("normalizes and filters the tools/list payload", async () => {
    // A server's tool list is untrusted: only object entries with a name that
    // passes the operation-name allowlist survive, and only the known fields
    // are carried forward.
    const harness = makeFakeChild((frame, api) => {
      if (frame.id === undefined) {
        return;
      }
      if (frame.method === "tools/list") {
        api.emit({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            tools: [
              {
                name: "search",
                description: "ok",
                inputSchema: { type: "object" },
                annotations: { a: 1 },
              },
              { name: "bad name; rm -rf /" }, // rejected by the name allowlist
              { description: "no name" }, // no string name
              null, // not an object
              42, // not an object
            ],
          },
        });
        return;
      }
      api.emit({ jsonrpc: "2.0", id: frame.id, result: {} });
    });
    spawnMock.mockReturnValue(harness.child);

    const listing = await listMcpTools({
      transport: { type: "stdio", command: "notion-mcp", args: ["--verbose"] },
    });

    expect(listing.transport).toEqual({ command: "notion-mcp", type: "stdio" });
    expect(listing.tools).toEqual([
      {
        name: "search",
        description: "ok",
        inputSchema: { type: "object" },
        annotations: { a: 1 },
      },
    ]);
  });

  test("rejects when the server returns a JSON-RPC error object", async () => {
    // An `error` member (not a `result`) must reject with the server message so
    // a failed tool call surfaces rather than resolving to undefined.
    const harness = makeFakeChild((frame, api) => {
      if (frame.id === undefined) {
        return;
      }
      if (frame.method === "tools/call") {
        api.emit({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32000, message: "tool exploded" },
        });
        return;
      }
      api.emit({ jsonrpc: "2.0", id: frame.id, result: {} });
    });
    spawnMock.mockReturnValue(harness.child);

    await expect(
      executeMcpTool(
        { transport: { type: "stdio", command: "notion-mcp" } },
        "search",
        {},
      ),
    ).rejects.toThrow(/tool exploded/u);
  });

  test("ignores malformed, mistyped-id, and unknown-id stdout frames", async () => {
    // Untrusted stdout must not crash the client or resolve the wrong promise:
    // non-JSON lines, frames whose id is not a number, and ids with no pending
    // request are all dropped, and a later valid frame still completes the call.
    const harness = makeFakeChild((frame, api) => {
      if (frame.id === undefined) {
        return;
      }
      if (frame.method === "tools/call") {
        api.emitRaw("this is not json\n");
        api.emit({ jsonrpc: "2.0", id: "not-a-number", result: {} });
        api.emit({ jsonrpc: "2.0", id: 9999, result: {} });
        // Also exercise the stderr swallow path while noise is in flight.
        api.fireStderr("a warning on stderr");
        api.emit({ jsonrpc: "2.0", id: frame.id, result: { ok: true } });
        return;
      }
      api.emit({ jsonrpc: "2.0", id: frame.id, result: {} });
    });
    spawnMock.mockReturnValue(harness.child);

    const value = await executeMcpTool(
      { transport: { type: "stdio", command: "notion-mcp", args: ["--x"] } },
      "search",
      {},
    );
    expect(value).toEqual({ ok: true });
  });

  test("rejects every pending request when the child errors", async () => {
    // A spawn/pipe failure surfaces as a child 'error' event; all in-flight
    // requests must reject rather than hang forever.
    const harness = makeFakeChild((frame, api) => {
      if (frame.id === undefined) {
        return;
      }
      if (frame.method === "initialize") {
        api.fireChild("error", new Error("ENOENT: command not found"));
        return;
      }
      api.emit({ jsonrpc: "2.0", id: frame.id, result: {} });
    });
    spawnMock.mockReturnValue(harness.child);

    await expect(
      executeMcpTool(
        { transport: { type: "stdio", command: "notion-mcp" } },
        "search",
        {},
      ),
    ).rejects.toThrow(/ENOENT: command not found/u);
  });

  test("rejects pending requests when the child exits early", async () => {
    // An early exit (crash before answering) must reject with a diagnostic that
    // names the exit code/signal, not silently drop the request.
    const harness = makeFakeChild((frame, api) => {
      if (frame.id === undefined) {
        return;
      }
      if (frame.method === "initialize") {
        api.fireChild("exit", 1, null);
        return;
      }
      api.emit({ jsonrpc: "2.0", id: frame.id, result: {} });
    });
    spawnMock.mockReturnValue(harness.child);

    await expect(
      executeMcpTool(
        { transport: { type: "stdio", command: "notion-mcp" } },
        "search",
        {},
      ),
    ).rejects.toThrow(/exited early: code=1 signal=null/u);
  });

  test("rejects when a request outlives the per-request timeout", async () => {
    // A silent server must not block ingestion forever: the 60s per-request
    // timeout fires and rejects. Fake timers drive the clock so the suite never
    // actually waits.
    vi.useFakeTimers();
    const harness = makeFakeChild(() => undefined); // never answers anything
    spawnMock.mockReturnValue(harness.child);

    const pending = executeMcpTool(
      { transport: { type: "stdio", command: "notion-mcp" } },
      "search",
      {},
    );
    const assertion = expect(pending).rejects.toThrow(
      /Timed out waiting for MCP response to initialize/u,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });
});

/**
 * Installs a fetch stub that answers MCP JSON-RPC posts. `overrides` maps a
 * method name (or "notify" for id-less notifications) to a function returning a
 * Response; anything unmapped gets a default JSON success frame. Returns the
 * stub plus a running log of the calls so tests can assert URL/header targeting.
 */
function installMcpFetch(
  overrides: Record<string, (frame: { id?: number }) => Response> = {},
): {
  stub: ReturnType<typeof vi.fn>;
  calls: {
    url: string;
    headers: Record<string, string>;
    frame: { id?: number; method?: string };
  }[];
} {
  const calls: {
    url: string;
    headers: Record<string, string>;
    frame: { id?: number; method?: string };
  }[] = [];

  const stub = vi.fn((url: string, init: RequestInit) => {
    const frame = JSON.parse(init.body as string) as {
      id?: number;
      method?: string;
    };
    calls.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      frame,
    });

    if (frame.id === undefined) {
      const notify = overrides.notify;
      return Promise.resolve(
        notify ? notify(frame) : new Response(null, { status: 202 }),
      );
    }

    const override = frame.method ? overrides[frame.method] : undefined;
    if (override) {
      return Promise.resolve(override(frame));
    }

    return Promise.resolve(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: defaultResultFor(frame.method),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  });

  vi.stubGlobal("fetch", stub);
  return { stub, calls };
}

describe("http MCP transport (stubbed fetch)", () => {
  const savedToken = process.env.MY_MCP_TOKEN;

  beforeEach(() => {
    process.env.MY_MCP_TOKEN = "s3cr3t-token";
  });

  afterEach(() => {
    if (savedToken === undefined) {
      delete process.env.MY_MCP_TOKEN;
    } else {
      process.env.MY_MCP_TOKEN = savedToken;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("posts JSON-RPC to a validated https URL and parses the JSON body", async () => {
    const { calls } = installMcpFetch();

    const result = await executeMcpReadOnlyOperations({
      transport: { type: "http", url: "https://mcp.example.com/rpc" },
      readOnlyOperations: [
        { name: "search", type: "tool" },
        { name: "doc://readme", type: "resource" },
      ],
    });

    expect(result.transport).toEqual({
      type: "http",
      url: "https://mcp.example.com/rpc",
    });
    expect(result.operations[0]).toMatchObject({
      name: "search",
      type: "tool",
    });
    // The resource branch of executeOperation posts a resources/read request.
    expect(result.operations[1]).toMatchObject({
      name: "doc://readme",
      type: "resource",
    });
    expect(calls.some((c) => c.frame.method === "resources/read")).toBe(true);

    // Every request targets the single validated https endpoint; no request is
    // ever sent to an unvalidated or downgraded (http) host.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).toBe("https://mcp.example.com/rpc");
    }
    // The first request is the initialize handshake.
    expect(calls[0].frame).toMatchObject({ method: "initialize", id: 1 });
  });

  test("sends the resolved Authorization header only to the validated host", async () => {
    const { calls } = installMcpFetch();

    await listMcpTools({
      transport: {
        type: "http",
        url: "https://mcp.example.com/rpc",
        // The credential is referenced via ${ENV}; its value is resolved from
        // process.env and must reach only the validated host.
        headers: { Authorization: "Bearer ${MY_MCP_TOKEN}" },
      },
    });

    // Header-leak safety: the secret went out attached to the validated https
    // endpoint and nowhere else.
    for (const call of calls) {
      expect(call.url).toBe("https://mcp.example.com/rpc");
      expect(call.headers.Authorization).toBe("Bearer s3cr3t-token");
    }
  });

  test("threads a server-issued session id onto later requests", async () => {
    // The server binds the session via Mcp-Session-Id on the initialize reply;
    // every subsequent request must echo it so state is preserved.
    const { calls } = installMcpFetch({
      initialize: (frame) =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "sess-42",
            },
          },
        ),
    });

    await executeMcpTool(
      { transport: { type: "http", url: "https://mcp.example.com/rpc" } },
      "search",
      {},
    );

    const initialize = calls.find((c) => c.frame.method === "initialize");
    const toolCall = calls.find((c) => c.frame.method === "tools/call");
    expect(initialize?.headers["Mcp-Session-Id"]).toBeUndefined();
    expect(toolCall?.headers["Mcp-Session-Id"]).toBe("sess-42");
  });

  test("parses a text/event-stream (SSE) body, skipping non-result frames", async () => {
    // The MCP spec allows the JSON-RPC reply to arrive as SSE. parseSseDataLines
    // must join data: lines per event, ignore comments/blank separators, skip a
    // frame that carries neither id/result/error, and return the real result.
    const sseBody = [
      ": keep-alive comment",
      'data: {"jsonrpc":"2.0"}', // no id/result/error -> skipped
      "",
      'data: {"jsonrpc":"2.0","id":2,',
      'data: "result":{"tools":[{"name":"search"}]}}',
      "",
    ].join("\n");

    const { calls } = installMcpFetch({
      "tools/list": () =>
        new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      // Exercise the empty-body branch of parseHttpMcpResponse: a 200 with no
      // content for the id-less notification.
      notify: () =>
        new Response("", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    const listing = await listMcpTools({
      transport: { type: "http", url: "https://mcp.example.com/rpc" },
    });

    expect(listing.tools).toEqual([{ name: "search" }]);
    expect(calls.some((c) => c.frame.method === "tools/list")).toBe(true);
  });

  test("rejects a JSON-RPC error object in the http response", async () => {
    installMcpFetch({
      "tools/call": (frame) =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            error: { code: -32000, message: "remote refused" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(
      executeMcpTool(
        { transport: { type: "http", url: "https://mcp.example.com/rpc" } },
        "search",
        {},
      ),
    ).rejects.toThrow(/remote refused/u);
  });

  test("rejects on a non-ok http status", async () => {
    // A non-retryable 4xx must surface as an error naming the status rather than
    // being parsed as a JSON-RPC body.
    installMcpFetch({
      initialize: () => new Response("nope", { status: 400 }),
    });

    await expect(
      executeMcpTool(
        { transport: { type: "http", url: "https://mcp.example.com/rpc" } },
        "search",
        {},
      ),
    ).rejects.toThrow(/MCP HTTP request failed: 400/u);
  });

  test("rejects a malformed SSE frame", async () => {
    // Untrusted SSE payloads that are not valid JSON must reject, not silently
    // resolve.
    installMcpFetch({
      initialize: () =>
        new Response("data: {not valid json}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    await expect(
      executeMcpTool(
        { transport: { type: "http", url: "https://mcp.example.com/rpc" } },
        "search",
        {},
      ),
    ).rejects.toThrow();
  });

  test("localhost may use plain http", async () => {
    // The one allowed cleartext exception: a loopback host for local dev.
    const { calls } = installMcpFetch();

    await executeMcpTool(
      { transport: { type: "http", url: "http://localhost:8080/rpc" } },
      "search",
      {},
    );

    expect(calls[0].url).toBe("http://localhost:8080/rpc");
  });
});

describe("http MCP header resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("rejects a literal credential that does not use ${ENV}", async () => {
    // Secrets must be referenced through env, never pasted as a literal, so they
    // are not committed to config. fetch must never be reached.
    const { stub } = installMcpFetch();

    await expect(
      listMcpTools({
        transport: {
          type: "http",
          url: "https://mcp.example.com/rpc",
          headers: { Authorization: "Bearer literal-secret" },
        },
      }),
    ).rejects.toThrow(/must reference credentials with/u);
    expect(stub).not.toHaveBeenCalled();
  });

  test("rejects an invalid HTTP header name", async () => {
    const { stub } = installMcpFetch();

    await expect(
      listMcpTools({
        transport: {
          type: "http",
          url: "https://mcp.example.com/rpc",
          headers: { "Bad Header!": "value" },
        },
      }),
    ).rejects.toThrow(/Invalid HTTP header name/u);
    expect(stub).not.toHaveBeenCalled();
  });

  test("passes through a non-credential literal header unchanged", async () => {
    const { calls } = installMcpFetch();

    await listMcpTools({
      transport: {
        type: "http",
        url: "https://mcp.example.com/rpc",
        headers: { "X-Client": "openwiki" },
      },
    });

    expect(calls[0].headers["X-Client"]).toBe("openwiki");
  });
});

// These guards fire AFTER pre-flight validateMcpTransport (which only checks a
// transport exists): a stdio transport can still lack a command, and an http
// transport can still lack a url, once dispatch reaches the transport-specific
// entry point.
describe("post-validation transport guards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("stdio execute rejects when command is missing", async () => {
    await expect(
      executeMcpReadOnlyOperations({
        transport: { type: "stdio" },
        readOnlyOperations: [VALID_TOOL_OP],
      }),
    ).rejects.toThrow(/stdio MCP transport requires a command/u);
  });

  test("stdio tool call rejects when command is missing", async () => {
    await expect(
      executeMcpTool({ transport: { type: "stdio" } }, "search", {}),
    ).rejects.toThrow(/stdio MCP transport requires a command/u);
  });

  test("stdio listing rejects when command is missing", async () => {
    await expect(
      listMcpTools({ transport: { type: "stdio" } }),
    ).rejects.toThrow(/stdio MCP transport requires a command/u);
  });

  test("http tool call rejects when url is missing", async () => {
    await expect(
      executeMcpTool({ transport: { type: "http" } }, "search", {}),
    ).rejects.toThrow(/HTTP MCP transport requires a URL/u);
  });
});

describe("tool-list normalization edge cases", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("yields no tools when the result lacks a tools array", async () => {
    // A well-formed but tools-less result must degrade to an empty list rather
    // than throw.
    installMcpFetch({
      "tools/list": (frame) =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const listing = await listMcpTools({
      transport: { type: "http", url: "https://mcp.example.com/rpc" },
    });
    expect(listing.tools).toEqual([]);
  });

  test("SSE without a result-bearing frame resolves to an empty response", async () => {
    // Every SSE event is a keep-alive/ping with no id/result/error, and the body
    // has no trailing blank line, so the final data buffer is flushed by the
    // tail path. The request resolves with an empty result.
    const sseBody = [
      'data: {"jsonrpc":"2.0"}',
      "",
      'data: {"jsonrpc":"2.0"}',
    ].join("\n");
    installMcpFetch({
      "tools/list": () =>
        new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    const listing = await listMcpTools({
      transport: { type: "http", url: "https://mcp.example.com/rpc" },
    });
    expect(listing.tools).toEqual([]);
  });
});

describe("stdio client deferred kill", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("force-kills a child that has not exited when close's grace timer fires", async () => {
    // close() ends stdin and schedules a 1s fallback kill; if the process is
    // still alive (exitCode null) it is killed so no orphan lingers.
    vi.useFakeTimers();
    const harness = makeFakeChild(respondOk);
    const killSpy = vi.spyOn(harness.child, "kill");
    spawnMock.mockReturnValue(harness.child);

    await executeMcpTool(
      { transport: { type: "stdio", command: "notion-mcp" } },
      "search",
      {},
    );

    expect(killSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(killSpy).toHaveBeenCalledTimes(1);
  });
});

describe("listMcpTools pagination", () => {
  const MCP_URL = "https://mcp.example.com/mcp";

  type JsonRpcCall = {
    method: string;
    params?: Record<string, unknown>;
  };

  /**
   * Stubs an HTTP MCP server that answers `initialize` and then serves the
   * given `tools/list` pages in order, recording every JSON-RPC call it saw.
   */
  function stubHttpMcpServer(pages: Record<string, unknown>[]): JsonRpcCall[] {
    const calls: JsonRpcCall[] = [];
    let pageIndex = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init?: { body?: string }) => {
        const message = JSON.parse(init?.body ?? "{}") as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };
        calls.push({ method: message.method, params: message.params });

        const result =
          message.method === "tools/list"
            ? (pages[Math.min(pageIndex++, pages.length - 1)] ?? { tools: [] })
            : {};

        return Promise.resolve(
          new Response(
            JSON.stringify({ id: message.id, jsonrpc: "2.0", result }),
            { headers: { "content-type": "application/json" }, status: 200 },
          ),
        );
      }),
    );

    return calls;
  }

  function listToolsCalls(calls: JsonRpcCall[]): JsonRpcCall[] {
    return calls.filter((call) => call.method === "tools/list");
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("follows nextCursor so tools past the first page are discovered", async () => {
    const calls = stubHttpMcpServer([
      { nextCursor: "cursor-2", tools: [{ name: "page_one_tool" }] },
      { tools: [{ name: "page_two_tool" }] },
    ]);

    const result = await listMcpTools({
      transport: { type: "http", url: MCP_URL },
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "page_one_tool",
      "page_two_tool",
    ]);
    // The second page must be requested with the cursor the server handed back.
    expect(listToolsCalls(calls).map((call) => call.params)).toEqual([
      {},
      { cursor: "cursor-2" },
    ]);
  });

  test("issues a single request when the server does not paginate", async () => {
    const calls = stubHttpMcpServer([{ tools: [{ name: "only_tool" }] }]);

    const result = await listMcpTools({
      transport: { type: "http", url: MCP_URL },
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["only_tool"]);
    expect(listToolsCalls(calls)).toHaveLength(1);
  });

  test("stops instead of looping when a server repeats the same cursor", async () => {
    const calls = stubHttpMcpServer([
      { nextCursor: "stuck", tools: [{ name: "first_tool" }] },
      { nextCursor: "stuck", tools: [{ name: "second_tool" }] },
    ]);

    const result = await listMcpTools({
      transport: { type: "http", url: MCP_URL },
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "first_tool",
      "second_tool",
    ]);
    expect(listToolsCalls(calls)).toHaveLength(2);
  });

  test("caps the number of pages when a server always returns a fresh cursor", async () => {
    const calls: JsonRpcCall[] = [];
    let cursorSeed = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init?: { body?: string }) => {
        const message = JSON.parse(init?.body ?? "{}") as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };
        calls.push({ method: message.method, params: message.params });

        cursorSeed += 1;
        const result =
          message.method === "tools/list"
            ? {
                nextCursor: `cursor-${cursorSeed}`,
                tools: [{ name: `tool_${cursorSeed}` }],
              }
            : {};

        return Promise.resolve(
          new Response(
            JSON.stringify({ id: message.id, jsonrpc: "2.0", result }),
            { headers: { "content-type": "application/json" }, status: 200 },
          ),
        );
      }),
    );

    const result = await listMcpTools({
      transport: { type: "http", url: MCP_URL },
    });

    // Terminates on the page cap rather than following cursors forever.
    expect(listToolsCalls(calls)).toHaveLength(100);
    expect(result.tools).toHaveLength(100);
  });
});
