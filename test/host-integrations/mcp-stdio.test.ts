import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const transport = vi.hoisted(() => ({
  starts: vi.fn(() => Promise.resolve()),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown) => void;

    async start(): Promise<void> {
      await transport.starts();
    }

    async close(): Promise<void> {}

    async send(): Promise<void> {}
  },
}));

import { runOpenWikiMcp } from "../../src/host-integrations/mcp/stdio.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  transport.starts.mockClear();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("OpenWiki MCP stdio entry point", () => {
  test("starts the transport without printing a banner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-mcp-stdio-"));
    temporaryRoots.push(root);
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runOpenWikiMcp({ root, host: "codex" });

    expect(transport.starts).toHaveBeenCalledOnce();
    expect(stdout).not.toHaveBeenCalled();
  });
});
