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

import { runOpenWikiMcp } from "../../src/integrations/mcp/stdio.ts";

afterEach(() => {
  vi.restoreAllMocks();
  transport.starts.mockClear();
});

describe("OpenWiki MCP stdio entry point", () => {
  test("starts the transport without printing a banner", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runOpenWikiMcp({ host: "codex" });

    expect(transport.starts).toHaveBeenCalledOnce();
    expect(stdout).not.toHaveBeenCalled();
  });
});
