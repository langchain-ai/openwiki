import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { ClaimsStore } from "../../src/claims/brains/code/store.ts";
import { HostIntegrationError } from "../../src/integrations/core/errors.ts";
import type { ProtocolTool } from "../../src/integrations/core/protocol.ts";
import { HostSessionManager } from "../../src/integrations/core/session-manager.ts";
import {
  createOpenWikiMcpServer,
  type HostToolProvider,
} from "../../src/integrations/mcp/server.ts";

const temporaryRoots: string[] = [];

/**
 * Connected in-memory MCP fixture used by transport tests.
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
 * Creates a transport-neutral provider from explicit test tools.
 *
 * @param tools - Complete tool list exposed through the adapter.
 * @returns Minimal host tool provider.
 */
function provider(...tools: ProtocolTool[]): HostToolProvider {
  return { tools: () => tools };
}

/**
 * Connects an MCP client and server through linked memory transports.
 *
 * @param toolProvider - Lifecycle provider registered by the server.
 * @returns Connected client/server fixture.
 */
async function connect(
  toolProvider: HostToolProvider,
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
 * Closes both halves of one connected transport fixture.
 *
 * @param fixture - Connected MCP client and server.
 */
async function close(fixture: ConnectedMcpFixture): Promise<void> {
  await fixture.client.close();
  if (fixture.server.isConnected()) await fixture.server.close();
}

/**
 * Creates an isolated Git repository containing stable Claim evidence.
 *
 * @returns Absolute temporary repository root.
 */
async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-mcp-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  await writeFile(path.join(root, "README.md"), "# Repository\n", "utf8");
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("OpenWiki MCP adapter", () => {
  test("advertises exactly the five lifecycle calls and workflow guidance", async () => {
    const schema = z.object({ runId: z.string().optional() }).strict();
    const handle = () => Promise.resolve({ status: "ok" });
    const fixture = await connect(
      provider(
        {
          name: "openwiki_begin",
          description: "Begin.",
          schema,
          handle,
        },
        {
          name: "openwiki_submit_plan",
          description: "Submit plan.",
          schema,
          handle,
        },
        {
          name: "openwiki_next_page",
          description: "Next page.",
          schema,
          handle,
        },
        {
          name: "openwiki_submit_page",
          description: "Submit page.",
          schema,
          handle,
        },
        {
          name: "openwiki_finish",
          description: "Finish.",
          schema,
          handle,
        },
      ),
    );

    try {
      expect(
        (await fixture.client.listTools()).tools.map(({ name }) => name),
      ).toEqual([
        "openwiki_begin",
        "openwiki_submit_plan",
        "openwiki_next_page",
        "openwiki_submit_page",
        "openwiki_finish",
      ]);
      const instructions = fixture.client.getInstructions();
      expect(instructions).toContain("host's native\nrepository tools");
      expect(instructions).toContain("openwiki_submit_plan");
      expect(instructions).toContain("openwiki_next_page");
      expect(instructions).toContain("openwiki_submit_page");
      expect(instructions).toContain("same Claim id and statement verbatim");
      expect(instructions).toContain(
        "stale or unresolved marker as a requirement to recheck",
      );
      expect(instructions).toContain("Never report\nsuccess before finish");
      expect(instructions).toContain("source\ndrift invalidated the plan");
      expect(instructions).not.toContain("openwiki_inspect_claims");
      expect(instructions).not.toContain("openwiki_resolve_claims");
    } finally {
      await close(fixture);
    }
  });

  test("returns text JSON and structured content for successful calls", async () => {
    const fixture = await connect(
      provider({
        name: "openwiki_begin",
        description: "Begin.",
        schema: z.object({ mode: z.literal("init") }).strict(),
        handle: () => Promise.resolve({ status: "active", mode: "init" }),
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
            text: JSON.stringify({ status: "active", mode: "init" }),
          },
        ],
        structuredContent: { status: "active", mode: "init" },
      });
    } finally {
      await close(fixture);
    }
  });

  test("preserves bounded host errors and hides unknown failures", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const fixture = await connect(
      provider(
        {
          name: "openwiki_next_page",
          description: "Next page.",
          schema: z.object({ runId: z.string() }).strict(),
          handle: () =>
            Promise.reject(
              new HostIntegrationError("invalid_state", "No active run."),
            ),
        },
        {
          name: "openwiki_finish",
          description: "Finish.",
          schema: z.object({ runId: z.string() }).strict(),
          handle: () => Promise.reject(new Error("SENSITIVE_SENTINEL")),
        },
      ),
    );

    try {
      await expect(
        fixture.client.callTool({
          name: "openwiki_next_page",
          arguments: { runId: "run" },
        }),
      ).resolves.toMatchObject({
        isError: true,
        content: [{ text: "invalid_state: No active run." }],
      });
      const unknown = await fixture.client.callTool({
        name: "openwiki_finish",
        arguments: { runId: "run" },
      });
      expect(JSON.stringify(unknown)).toContain(
        "OpenWiki MCP operation failed.",
      );
      expect(JSON.stringify(unknown)).not.toContain("SENSITIVE_SENTINEL");
      expect(JSON.stringify(stderr.mock.calls)).not.toContain(
        "SENSITIVE_SENTINEL",
      );
    } finally {
      await close(fixture);
    }
  });
});

describe("OpenWiki MCP lifecycle smoke test", () => {
  test("completes one factual init page through all five transport calls", async () => {
    const root = await createRepository();
    const fixture = await connect(
      HostSessionManager.create({
        host: "codex",
        now: () => new Date("2026-08-24T12:00:00.000Z"),
      }),
    );

    try {
      const begin = await fixture.client.callTool({
        name: "openwiki_begin",
        arguments: { root, mode: "init" },
      });
      const { runId } = z
        .object({ runId: z.string().uuid() })
        .parse(begin.structuredContent);

      const accepted = await fixture.client.callTool({
        name: "openwiki_submit_plan",
        arguments: {
          runId,
          pages: [
            {
              path: "/openwiki/quickstart.md",
              title: "Quickstart",
              purpose: "Orient repository readers.",
              seedPaths: ["README.md"],
            },
          ],
        },
      });
      expect(accepted.structuredContent).toEqual({
        status: "accepted",
        totalPages: 1,
      });

      const next = await fixture.client.callTool({
        name: "openwiki_next_page",
        arguments: { runId },
      });
      const { job } = z
        .object({ job: z.object({ id: z.string().uuid() }) })
        .parse(next.structuredContent);
      await writeFile(
        path.join(root, "openwiki/quickstart.md"),
        [
          "---",
          "type: Guide",
          "title: Quickstart",
          "description: Repository quickstart.",
          "---",
          "",
          "# Quickstart",
          "",
          "The repository is introduced by its README.",
          "",
        ].join("\n"),
        "utf8",
      );

      const submitted = await fixture.client.callTool({
        name: "openwiki_submit_page",
        arguments: {
          runId,
          jobId: job.id,
          claims: [
            {
              statement: "The repository is introduced by its README.",
              evidence: [{ resource: "repo://README.md" }],
            },
          ],
        },
      });
      expect(submitted.structuredContent).toMatchObject({
        status: "complete",
        page: "/openwiki/quickstart.md",
        remaining: 0,
      });
      await expect(
        fixture.client.callTool({
          name: "openwiki_next_page",
          arguments: { runId },
        }),
      ).resolves.toMatchObject({ structuredContent: { status: "complete" } });
      await expect(
        fixture.client.callTool({
          name: "openwiki_finish",
          arguments: { runId },
        }),
      ).resolves.toMatchObject({
        structuredContent: { status: "complete" },
      });
      await expect(
        new ClaimsStore(root).loadPage("/openwiki/quickstart.md"),
      ).resolves.toMatchObject({
        claims: [{ statement: "The repository is introduced by its README." }],
      });
    } finally {
      await close(fixture);
    }
  });
});
