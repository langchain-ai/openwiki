import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { writeTextAtomic } from "../../src/integrations/install/atomic-file.ts";
import {
  getJsonMcpEntryStatus,
  installJsonMcpEntry,
  uninstallJsonMcpEntry,
} from "../../src/integrations/install/config-json.ts";
import {
  getCodexMcpBlockStatus,
  installCodexMcpBlock,
  uninstallCodexMcpBlock,
} from "../../src/integrations/install/config-toml.ts";
import type { HostMcpServerCommand } from "../../src/integrations/install/types.ts";

const ENTRY: HostMcpServerCommand = {
  command: "openwiki",
  args: ["mcp", "--host", "claude"],
};
const CODEX_ENTRY: HostMcpServerCommand = {
  command: "openwiki",
  args: ["mcp", "--host", "codex"],
};
const temporaryRoots: string[] = [];

/**
 * Creates one isolated adapter-test directory.
 *
 * @returns Absolute temporary directory path.
 */
async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-config-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("atomic host config writes", () => {
  test("preserves mode bits and leaves no temporary sibling", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "config.json");
    await writeFile(filePath, "old\n", { encoding: "utf8", mode: 0o600 });
    await chmod(filePath, 0o600);

    await writeTextAtomic(filePath, "new\n");

    expect(await readFile(filePath, "utf8")).toBe("new\n");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(["config.json"]);
  });
});

describe("JSON MCP config ownership", () => {
  test("creates, preserves, recognizes, and removes the exact entry", async () => {
    const root = await createRoot();
    const filePath = path.join(root, ".mcp.json");
    await writeFile(
      filePath,
      `${JSON.stringify({
        project: "kept",
        mcpServers: {
          other: { command: "other" },
        },
      })}\n`,
      "utf8",
    );

    await expect(installJsonMcpEntry(filePath, ENTRY)).resolves.toBe(true);
    const installed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    expect(installed).toMatchObject({
      project: "kept",
      mcpServers: {
        other: { command: "other" },
        openwiki: ENTRY,
      },
    });
    await expect(getJsonMcpEntryStatus(filePath, ENTRY)).resolves.toBe(
      "installed",
    );
    await expect(installJsonMcpEntry(filePath, ENTRY)).resolves.toBe(false);
    await expect(uninstallJsonMcpEntry(filePath, ENTRY)).resolves.toBe(true);
    await expect(getJsonMcpEntryStatus(filePath, ENTRY)).resolves.toBe(
      "not-installed",
    );
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      project: "kept",
      mcpServers: { other: { command: "other" } },
    });
  });

  test("treats property order as irrelevant but rejects shape drift", async () => {
    const root = await createRoot();
    const filePath = path.join(root, ".mcp.json");
    await writeFile(
      filePath,
      '{"mcpServers":{"openwiki":{"args":["mcp","--host","claude"],"command":"openwiki"}}}\n',
      "utf8",
    );
    await expect(installJsonMcpEntry(filePath, ENTRY)).resolves.toBe(false);

    await writeFile(
      filePath,
      '{"mcpServers":{"openwiki":{"command":"custom","args":[]}}}\n',
      "utf8",
    );
    const before = await readFile(filePath, "utf8");
    await expect(installJsonMcpEntry(filePath, ENTRY)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(uninstallJsonMcpEntry(filePath, ENTRY)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await readFile(filePath, "utf8")).toBe(before);
  });

  test("rejects malformed JSON without changing bytes", async () => {
    const root = await createRoot();
    const filePath = path.join(root, ".mcp.json");
    const malformed = "{ comments: are-not-json }\n";
    await writeFile(filePath, malformed, "utf8");

    await expect(installJsonMcpEntry(filePath, ENTRY)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(await readFile(filePath, "utf8")).toBe(malformed);
    await expect(getJsonMcpEntryStatus(filePath, ENTRY)).resolves.toBe(
      "modified",
    );
  });

  test("replaces only an explicitly recognized prior entry", async () => {
    const root = await createRoot();
    const filePath = path.join(root, ".mcp.json");
    const localEntry: HostMcpServerCommand = {
      command: "/opt/node/bin/node",
      args: ["/repo/dist/cli/cli.js", "mcp", "--host", "claude"],
    };
    await writeFile(
      filePath,
      `${JSON.stringify({ mcpServers: { openwiki: ENTRY } })}\n`,
      "utf8",
    );

    await expect(
      installJsonMcpEntry(filePath, localEntry, ENTRY),
    ).resolves.toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      mcpServers: { openwiki: localEntry },
    });
  });
});

describe("Codex TOML MCP block ownership", () => {
  test("preserves every byte outside the exact managed block", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "config.toml");
    const prefix = 'model = "gpt-5"\n\n';
    await writeFile(filePath, prefix, "utf8");

    await expect(installCodexMcpBlock(filePath, CODEX_ENTRY)).resolves.toBe(
      true,
    );
    const installed = await readFile(filePath, "utf8");
    expect(installed.startsWith(prefix)).toBe(true);
    expect(installed).toContain('[mcp_servers.openwiki]\ncommand = "openwiki"');
    expect(installed).toContain('args = ["mcp", "--host", "codex"]');
    await expect(getCodexMcpBlockStatus(filePath, CODEX_ENTRY)).resolves.toBe(
      "installed",
    );
    await expect(installCodexMcpBlock(filePath, CODEX_ENTRY)).resolves.toBe(
      false,
    );
    await expect(uninstallCodexMcpBlock(filePath, CODEX_ENTRY)).resolves.toBe(
      true,
    );
    expect(await readFile(filePath, "utf8")).toBe(prefix);
  });

  test.each([
    "# OPENWIKI:MCP:START\n",
    "# OPENWIKI:MCP:END\n",
    "# OPENWIKI:MCP:END\n# OPENWIKI:MCP:START\n",
    "# OPENWIKI:MCP:START\n# OPENWIKI:MCP:START\n# OPENWIKI:MCP:END\n",
  ])("rejects invalid marker structure byte-identically", async (content) => {
    const root = await createRoot();
    const filePath = path.join(root, "config.toml");
    await writeFile(filePath, content, "utf8");

    await expect(
      installCodexMcpBlock(filePath, CODEX_ENTRY),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await readFile(filePath, "utf8")).toBe(content);
  });

  test("rejects unmanaged and modified OpenWiki tables", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "config.toml");
    const unmanaged = '[mcp_servers.openwiki]\ncommand = "custom"\n';
    await writeFile(filePath, unmanaged, "utf8");
    await expect(
      installCodexMcpBlock(filePath, CODEX_ENTRY),
    ).rejects.toMatchObject({ code: "conflict" });

    const modified = [
      "# OPENWIKI:MCP:START",
      "[mcp_servers.openwiki]",
      'command = "custom"',
      'args = ["mcp", "--host", "codex"]',
      "# OPENWIKI:MCP:END",
      "",
    ].join("\n");
    await writeFile(filePath, modified, "utf8");
    await expect(
      uninstallCodexMcpBlock(filePath, CODEX_ENTRY),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(filePath, "utf8")).toBe(modified);
    await expect(getCodexMcpBlockStatus(filePath, CODEX_ENTRY)).resolves.toBe(
      "modified",
    );

    const duplicateTable = `${modified.replace(
      'command = "custom"',
      'command = "openwiki"',
    )}\n[mcp_servers.openwiki]\ncommand = "shadow"\n`;
    await writeFile(filePath, duplicateTable, "utf8");
    await expect(
      installCodexMcpBlock(filePath, CODEX_ENTRY),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(filePath, "utf8")).toBe(duplicateTable);
  });

  test("replaces only an explicitly recognized prior block", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "config.toml");
    const localEntry: HostMcpServerCommand = {
      command: "/opt/node/bin/node",
      args: ["/repo/dist/cli/cli.js", "mcp", "--host", "codex"],
    };

    await installCodexMcpBlock(filePath, CODEX_ENTRY);
    await expect(
      installCodexMcpBlock(filePath, localEntry, CODEX_ENTRY),
    ).resolves.toBe(true);
    const installed = await readFile(filePath, "utf8");
    expect(installed).toContain('command = "/opt/node/bin/node"');
    expect(installed).toContain(
      'args = ["/repo/dist/cli/cli.js", "mcp", "--host", "codex"]',
    );
  });
});
