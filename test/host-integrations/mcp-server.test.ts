import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { HostIntegrationError } from "../../src/host-integrations/core/errors.ts";
import type { ProtocolTool } from "../../src/host-integrations/core/protocol.ts";
import { HostSessionManager } from "../../src/host-integrations/core/session-manager.ts";
import {
  createOpenWikiMcpServer,
  type HostLifecycleToolProvider,
} from "../../src/host-integrations/mcp/server.ts";

const temporaryRoots: string[] = [];

/**
 * Connected in-memory MCP fixture used by adapter tests.
 */
interface ConnectedMcpFixture {
  /**
   * Initialized MCP client.
   */
  client: Client;

  /**
   * Connected OpenWiki MCP server.
   */
  server: McpServer;
}

/**
 * Creates an isolated repository root for an MCP lifecycle test.
 *
 * @returns Absolute temporary repository path.
 */
async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-mcp-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  return root;
}

/**
 * Creates a transport-neutral tool provider from explicit test tools.
 *
 * @param tools - Tools returned to the MCP adapter.
 * @returns Minimal lifecycle provider used by adapter tests.
 */
function provider(...tools: ProtocolTool[]): HostLifecycleToolProvider {
  return { tools: () => tools };
}

/**
 * Connects an MCP client and server through an in-memory transport pair.
 *
 * @param toolProvider - Lifecycle tools registered by the server.
 * @returns Connected client and server.
 */
async function connect(
  toolProvider: HostLifecycleToolProvider,
): Promise<ConnectedMcpFixture> {
  const server = createOpenWikiMcpServer(toolProvider);
  const client = new Client({ name: "openwiki-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

/**
 * Closes both halves of a connected in-memory MCP fixture.
 *
 * @param client - Connected MCP client.
 * @param server - Connected MCP server.
 */
async function close(client: Client, server: McpServer): Promise<void> {
  await client.close();
  if (server.isConnected()) {
    await server.close();
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("OpenWiki MCP adapter", () => {
  test("advertises only lifecycle tools and native-host authoring guidance", async () => {
    const begin = vi.fn(() => Promise.resolve({ runId: "run-1" }));
    const finish = vi.fn(() => Promise.resolve({ status: "complete" }));
    const fixture = await connect(
      provider(
        {
          name: "openwiki_begin",
          description: "Begin.",
          schema: z.object({ mode: z.enum(["init", "update"]) }).strict(),
          handle: begin,
        },
        {
          name: "openwiki_finish",
          description: "Finish.",
          schema: z.object({ runId: z.string() }).strict(),
          handle: finish,
        },
      ),
    );

    try {
      const listed = await fixture.client.listTools();

      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "openwiki_begin",
        "openwiki_finish",
      ]);
      expect(listed.tools.map((tool) => tool.name)).not.toEqual(
        expect.arrayContaining(["read_file", "write_file", "edit_file"]),
      );
      expect(fixture.client.getInstructions()).toContain(
        "Use the host's native repository tools",
      );
      expect(fixture.client.getInstructions()).toContain(
        "Resolve the absolute Git top-level",
      );
      expect(fixture.client.getInstructions()).toContain(
        "Call openwiki_finish after authoring",
      );
    } finally {
      await close(fixture.client, fixture.server);
    }
  });

  test("returns text JSON and structured content for successful calls", async () => {
    const fixture = await connect(
      provider({
        name: "openwiki_begin",
        description: "Begin.",
        schema: z.object({ mode: z.literal("init") }).strict(),
        handle: () => Promise.resolve({ runId: "run-1", mode: "init" }),
      }),
    );

    try {
      const result = await fixture.client.callTool({
        name: "openwiki_begin",
        arguments: { mode: "init" },
      });

      expect(result).toMatchObject({
        content: [
          {
            type: "text",
            text: JSON.stringify({ runId: "run-1", mode: "init" }),
          },
        ],
        structuredContent: { runId: "run-1", mode: "init" },
      });
    } finally {
      await close(fixture.client, fixture.server);
    }
  });

  test("rejects invalid input before entering the lifecycle core", async () => {
    const handle = vi.fn(() => Promise.resolve({ runId: "unreachable" }));
    const fixture = await connect(
      provider({
        name: "openwiki_begin",
        description: "Begin.",
        schema: z.object({ mode: z.literal("init") }).strict(),
        handle,
      }),
    );

    try {
      const result = await fixture.client.callTool({
        name: "openwiki_begin",
        arguments: { mode: "update", extra: true },
      });

      expect(result.isError).toBe(true);
      expect(handle).not.toHaveBeenCalled();
    } finally {
      await close(fixture.client, fixture.server);
    }
  });

  test("preserves domain error codes", async () => {
    const fixture = await connect(
      provider({
        name: "openwiki_finish",
        description: "Finish.",
        schema: z.object({ runId: z.string() }).strict(),
        handle: () =>
          Promise.reject(
            new HostIntegrationError(
              "invalid_state",
              "No matching OpenWiki run is active.",
            ),
          ),
      }),
    );

    try {
      const result = await fixture.client.callTool({
        name: "openwiki_finish",
        arguments: { runId: "missing" },
      });

      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: "invalid_state: No matching OpenWiki run is active.",
          },
        ],
      });
    } finally {
      await close(fixture.client, fixture.server);
    }
  });

  test("does not expose unknown exception details", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const fixture = await connect(
      provider({
        name: "openwiki_finish",
        description: "Finish.",
        schema: z.object({ runId: z.string() }).strict(),
        handle: () => Promise.reject(new Error("SENSITIVE_EXCEPTION_SENTINEL")),
      }),
    );

    try {
      const result = await fixture.client.callTool({
        name: "openwiki_finish",
        arguments: { runId: "run-1" },
      });
      const serialized = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(serialized).toContain("OpenWiki MCP operation failed.");
      expect(serialized).not.toContain("SENSITIVE_EXCEPTION_SENTINEL");
      expect(stderr).toHaveBeenCalledWith("OpenWiki MCP operation failed.\n");
      expect(JSON.stringify(stderr.mock.calls)).not.toContain(
        "SENSITIVE_EXCEPTION_SENTINEL",
      );
    } finally {
      await close(fixture.client, fixture.server);
    }
  });
});

describe("OpenWiki MCP lifecycle transport", () => {
  test("initializes, begins, and finishes through a real linked transport", async () => {
    const root = await createRepository();
    const wikiRoot = path.join(root, "openwiki");
    const manager = HostSessionManager.create({ host: "codex" });
    const fixture = await connect(manager);

    try {
      const listed = await fixture.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "openwiki_begin",
        "openwiki_finish",
      ]);

      const begin = await fixture.client.callTool({
        name: "openwiki_begin",
        arguments: { root, mode: "init" },
      });
      expect(begin.isError).not.toBe(true);
      const { runId } = z
        .object({ runId: z.string() })
        .parse(begin.structuredContent);

      await mkdir(wikiRoot, { recursive: true });
      await writeFile(
        path.join(wikiRoot, "quickstart.md"),
        [
          "---",
          "type: Guide",
          "title: Quickstart",
          "description: Repository quickstart.",
          "---",
          "",
          "# Quickstart",
          "",
          "Host-authored documentation.",
          "",
        ].join("\n"),
        "utf8",
      );

      const finish = await fixture.client.callTool({
        name: "openwiki_finish",
        arguments: { runId },
      });
      expect(finish).toMatchObject({
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "complete" }),
          },
        ],
        structuredContent: { status: "complete" },
      });
    } finally {
      await close(fixture.client, fixture.server);
    }
  });
});
