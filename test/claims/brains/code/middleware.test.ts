import { ToolMessage } from "@langchain/core/messages";
import { describe, expect, test, vi } from "vitest";
import { createClaimsReadNoteMiddleware } from "../../../../src/claims/brains/code/middleware.ts";
import { ClaimSession } from "../../../../src/claims/brains/code/session.ts";

type ClaimsMiddleware = ReturnType<typeof createClaimsReadNoteMiddleware>;
type ClaimsToolWrapper = NonNullable<ClaimsMiddleware["wrapToolCall"]>;

function createSession(): ClaimSession {
  const page = "/openwiki/page.md";
  return new ClaimSession({
    resolver: { resolve: () => Promise.resolve(null) },
    persisted: new Map([
      [
        page,
        {
          schemaVersion: 1,
          pageVersion: `sha256:${"a".repeat(64)}`,
          claims: [
            {
              id: "claim_stale",
              statement: "The feature exists.",
              evidence: [{ resource: "repo://src/feature.ts", version: "old" }],
            },
          ],
        },
      ],
    ]),
    issues: [
      {
        page,
        kind: "stale",
        claimId: "claim_stale",
        resources: ["repo://src/feature.ts"],
      },
    ],
    orphanPages: [],
  });
}

function createUngroundedSession(): ClaimSession {
  return new ClaimSession({
    resolver: { resolve: () => Promise.resolve(null) },
    persisted: new Map(),
    issues: [],
    orphanPages: [],
    ungroundedPages: ["/openwiki/page.md"],
  });
}

async function invokeMiddleware(
  middleware: ClaimsMiddleware,
  toolName: string,
  requestedPath: string,
  handler: Parameters<ClaimsToolWrapper>[1],
): Promise<Awaited<ReturnType<ClaimsToolWrapper>>> {
  const wrapper = middleware.wrapToolCall;
  if (!wrapper) throw new Error("Missing Claims middleware wrapper.");
  return wrapper(
    {
      toolCall: {
        args: { file_path: requestedPath },
        id: "claims-call-1",
        name: toolName,
      },
      tool: undefined,
      state: { messages: [] },
      runtime: {},
    },
    handler,
  );
}

describe("createClaimsReadNoteMiddleware", () => {
  test("appends a non-persisted note to an affected page read", async () => {
    const middleware = createClaimsReadNoteMiddleware(createSession());
    const message = new ToolMessage({
      content: "# Page\n",
      tool_call_id: "read-1",
    });

    const result = await invokeMiddleware(
      middleware,
      "read_file",
      "/openwiki/page.md",
      () => Promise.resolve(message),
    );

    expect(result).toBe(message);
    expect(message.content).toContain("# Page");
    expect(message.content).toContain("claim_stale (stale)");
    expect(message.content).toContain("not part of the file");
  });

  test("appends lazy guidance when a read page has no Claims", async () => {
    const middleware = createClaimsReadNoteMiddleware(
      createUngroundedSession(),
    );
    const message = new ToolMessage({
      content: "# Page\n",
      tool_call_id: "read-1",
    });

    await invokeMiddleware(middleware, "read_file", "/openwiki/page.md", () =>
      Promise.resolve(message),
    );

    expect(message.content).toContain("this page has no Claims yet");
    expect(message.content).toContain("Before");
    expect(message.content).toContain("Do not backfill");
  });

  test("supports Command-like read results", async () => {
    const middleware = createClaimsReadNoteMiddleware(createSession());
    const message = new ToolMessage({
      content: "# Page\n",
      tool_call_id: "read-1",
    });
    const command = { update: { messages: [message] } };

    const result = await invokeMiddleware(
      middleware,
      "read_file",
      "/openwiki/page.md",
      () => Promise.resolve(command as never),
    );

    expect(result).toBe(command);
    expect(message.content).toContain("OpenWiki Claims");
  });

  test("appends a note to structured DeepAgents read content", async () => {
    const middleware = createClaimsReadNoteMiddleware(createSession());
    const message = new ToolMessage({
      content: [{ type: "text", text: "# Page\n" }],
      tool_call_id: "read-1",
    });

    await invokeMiddleware(middleware, "read_file", "/openwiki/page.md", () =>
      Promise.resolve(message),
    );

    expect(message.content).toHaveLength(2);
    expect(message.content[0]).toEqual({ type: "text", text: "# Page\n" });
    expect(JSON.stringify(message.content[1])).toContain("claim_stale (stale)");
  });

  test.each([
    ["unaffected page", "read_file", "/openwiki/other.md"],
    ["structural page", "read_file", "/openwiki/index.md"],
    ["ordinary write", "write_file", "/openwiki/page.md"],
  ])("leaves an %s result untouched", async (_case, tool, page) => {
    const middleware = createClaimsReadNoteMiddleware(createSession());
    const message = new ToolMessage({
      content: "original",
      tool_call_id: "tool-1",
    });
    const handler = vi.fn(() => Promise.resolve(message));

    await invokeMiddleware(middleware, tool, page, handler);

    expect(message.content).toBe("original");
    expect(handler).toHaveBeenCalledOnce();
  });

  test("does not append a note to failed reads", async () => {
    const middleware = createClaimsReadNoteMiddleware(createSession());
    const message = new ToolMessage({
      content: "missing",
      status: "error",
      tool_call_id: "read-1",
    });

    await invokeMiddleware(middleware, "read_file", "/openwiki/page.md", () =>
      Promise.resolve(message),
    );

    expect(message.content).toBe("missing");
  });
});
