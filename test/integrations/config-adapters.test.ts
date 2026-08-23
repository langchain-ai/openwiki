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
import {
  getOpencodeMcpEntryStatus,
  installOpencodeMcpEntry,
  uninstallOpencodeMcpEntry,
} from "../../src/integrations/install/config-opencode.ts";
import type { HostMcpServerCommand } from "../../src/integrations/install/types.ts";

const ENTRY: HostMcpServerCommand = {
  command: "openwiki",
  args: ["mcp", "--host", "claude"],
};
const CODEX_ENTRY: HostMcpServerCommand = {
  command: "openwiki",
  args: ["mcp", "--host", "codex"],
};
const OPENCODE_ENTRY: HostMcpServerCommand = {
  command: "openwiki",
  args: ["mcp", "--host", "opencode"],
};
const OPENCODE_SHAPE = {
  type: "local",
  command: ["openwiki", "mcp", "--host", "opencode"],
  enabled: true,
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

describe("OpenCode JSONC MCP entry ownership", () => {
  test("creates, preserves, recognizes, and removes the exact entry", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");
    const before = [
      "{",
      "  // keep this comment",
      '  "$schema": "https://opencode.ai/config.json",',
      '  "mcp": {',
      '    "other": { "type": "remote", "url": "https://example.com" }',
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(filePath, before, "utf8");

    await expect(
      installOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    const installed = await readFile(filePath, "utf8");
    expect(installed).toContain("// keep this comment");
    expect(installed).toContain(
      '"other": { "type": "remote", "url": "https://example.com" }',
    );
    const parsed: unknown = JSON.parse(installed.replace(/^\s*\/\/.*$/gmu, ""));
    expect(parsed).toMatchObject({
      $schema: "https://opencode.ai/config.json",
      mcp: { other: { type: "remote" }, openwiki: OPENCODE_SHAPE },
    });

    await expect(
      getOpencodeMcpEntryStatus(filePath, OPENCODE_ENTRY),
    ).resolves.toBe("installed");
    await expect(
      installOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(false);
    await expect(
      uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    await expect(
      getOpencodeMcpEntryStatus(filePath, OPENCODE_ENTRY),
    ).resolves.toBe("not-installed");

    const after = await readFile(filePath, "utf8");
    expect(after).toContain("// keep this comment");
    expect(JSON.parse(after.replace(/^\s*\/\/.*$/gmu, ""))).toMatchObject({
      mcp: { other: { type: "remote" } },
    });
  });

  test("adds a missing mcp key without disturbing siblings or comments", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");
    const before = [
      "{",
      "  // model comment",
      '  "model": "anthropic/claude-sonnet-4-5"',
      "}",
      "",
    ].join("\n");
    await writeFile(filePath, before, "utf8");

    await expect(
      installOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    const installed = await readFile(filePath, "utf8");
    expect(installed).toContain("// model comment");
    expect(JSON.parse(installed.replace(/^\s*\/\/.*$/gmu, ""))).toMatchObject({
      model: "anthropic/claude-sonnet-4-5",
      mcp: { openwiki: OPENCODE_SHAPE },
    });
  });

  test("creates a minimal file when the config is missing or empty", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");

    await expect(
      installOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    expect(parsed).toMatchObject({ mcp: { openwiki: OPENCODE_SHAPE } });

    await writeFile(filePath, " \n ", "utf8");
    await expect(
      installOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      mcp: { openwiki: OPENCODE_SHAPE },
    });
  });

  test("handles trailing commas when inserting into a populated object", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");
    await writeFile(
      filePath,
      '{ "mcp": { "other": { "type": "local", "command": ["x"] } } }\n',
      "utf8",
    );
    await expect(
      installOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      mcp: { other: {}, openwiki: OPENCODE_SHAPE },
    });

    await writeFile(
      filePath,
      '{ "mcp": { "other": { "type": "local", "command": ["x"] }, } }\n',
      "utf8",
    );
    await expect(
      installOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      mcp: { other: {}, openwiki: OPENCODE_SHAPE },
    });
  });

  test("treats property order as irrelevant but rejects shape drift", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");
    await writeFile(
      filePath,
      '{"mcp":{"openwiki":{"enabled":true,"command":["openwiki","mcp","--host","opencode"],"type":"local"}}}\n',
      "utf8",
    );
    await expect(
      installOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(false);

    await writeFile(
      filePath,
      '{"mcp":{"openwiki":{"type":"local","command":["custom"],"enabled":true}}}\n',
      "utf8",
    );
    const before = await readFile(filePath, "utf8");
    await expect(
      installOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(filePath, "utf8")).toBe(before);
  });

  test("rejects malformed JSONC without changing bytes", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");
    const malformed = "{ mcp: is-not-jsonc }\n";
    await writeFile(filePath, malformed, "utf8");

    await expect(
      installOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await readFile(filePath, "utf8")).toBe(malformed);
    await expect(
      getOpencodeMcpEntryStatus(filePath, OPENCODE_ENTRY),
    ).resolves.toBe("modified");
  });

  test("replaces only an explicitly recognized prior entry", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");
    const localEntry: HostMcpServerCommand = {
      command: "/opt/node/bin/node",
      args: ["/repo/dist/cli/cli.js", "mcp", "--host", "opencode"],
    };
    await writeFile(
      filePath,
      `${JSON.stringify({ mcp: { openwiki: OPENCODE_SHAPE } })}\n`,
      "utf8",
    );

    await expect(
      installOpencodeMcpEntry(filePath, localEntry, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    expect(parsed).toMatchObject({
      mcp: {
        openwiki: {
          type: "local",
          command: [
            "/opt/node/bin/node",
            "/repo/dist/cli/cli.js",
            "mcp",
            "--host",
            "opencode",
          ],
          enabled: true,
        },
      },
    });
  });

  test("removes the entry when it is the last mcp property", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");
    await writeFile(
      filePath,
      '{"mcp":{"other":{"type":"local","command":["x"]},"openwiki":{"type":"local","command":["openwiki","mcp","--host","opencode"],"enabled":true}}}\n',
      "utf8",
    );
    await expect(
      uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      mcp: { other: { type: "local" } },
    });
  });

  test("removes the entry when it is a middle mcp property", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");
    await writeFile(
      filePath,
      '{"mcp":{"other":{"type":"local","command":["x"]},"openwiki":{"type":"local","command":["openwiki","mcp","--host","opencode"],"enabled":true},"third":{"type":"local","command":["y"]}}}\n',
      "utf8",
    );
    await expect(
      uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    expect(parsed).toMatchObject({
      mcp: {
        other: { type: "local", command: ["x"] },
        third: { type: "local", command: ["y"] },
      },
    });
  });

  test("removes the entry when it is the first mcp property", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");
    await writeFile(
      filePath,
      '{"mcp":{"openwiki":{"type":"local","command":["openwiki","mcp","--host","opencode"],"enabled":true},"other":{"type":"local","command":["x"]}}}\n',
      "utf8",
    );
    await expect(
      uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      mcp: { other: { type: "local", command: ["x"] } },
    });
  });

  test("treats a comment-only file as empty while preserving comments", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");
    const comments = "// machine-owned configuration\n// do not edit\n";
    await writeFile(filePath, comments, "utf8");

    await expect(
      getOpencodeMcpEntryStatus(filePath, OPENCODE_ENTRY),
    ).resolves.toBe("not-installed");
    await expect(
      uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(false);
    await expect(
      installOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);

    const installed = await readFile(filePath, "utf8");
    expect(installed.startsWith(comments)).toBe(true);
    expect(JSON.parse(installed.replace(/^\s*\/\/.*$/gmu, ""))).toMatchObject({
      mcp: { openwiki: OPENCODE_SHAPE },
    });
  });

  test("inserts into empty objects with a readable layout", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");
    await writeFile(filePath, "{}\n", "utf8");
    await expect(
      installOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      mcp: { openwiki: OPENCODE_SHAPE },
    });

    await writeFile(filePath, '{"mcp": {}}\n', "utf8");
    await expect(
      installOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      mcp: { openwiki: OPENCODE_SHAPE },
    });
  });

  test("uninstalls cleanly when comments interpose on separator commas", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");
    const entry =
      '{"type":"local","command":["openwiki","mcp","--host","opencode"],"enabled":true}';

    const firstWithFollowing =
      `{"mcp":{"openwiki":${entry} // keep\n,"other":{"type":"local","command":["x"]}}}` +
      "\n";
    await writeFile(filePath, firstWithFollowing, "utf8");
    await expect(
      uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    expect(
      JSON.parse(
        (await readFile(filePath, "utf8")).replace(/^\s*\/\/.*$/gmu, ""),
      ),
    ).toMatchObject({
      mcp: { other: { type: "local", command: ["x"] } },
    });

    const firstWithTrailingComma =
      `{"mcp":{"openwiki":${entry} /* keep */ ,}}` + "\n";
    await writeFile(filePath, firstWithTrailingComma, "utf8");
    await expect(
      uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      mcp: {},
    });

    const middleWithComment =
      `{"mcp":{"a":{"type":"local","command":["a"]}, "openwiki":${entry} // note\n, "b":{"type":"local","command":["b"]}}}` +
      "\n";
    await writeFile(filePath, middleWithComment, "utf8");
    await expect(
      uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    expect(
      JSON.parse(
        (await readFile(filePath, "utf8")).replace(/^\s*\/\/.*$/gmu, ""),
      ),
    ).toMatchObject({
      mcp: {
        a: { type: "local", command: ["a"] },
        b: { type: "local", command: ["b"] },
      },
    });

    const commentBeforeLeadingComma =
      `{"mcp":{"a":{"type":"local","command":["a"]}, // note\n "openwiki":${entry}}}` +
      "\n";
    await writeFile(filePath, commentBeforeLeadingComma, "utf8");
    await expect(
      uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    expect(
      JSON.parse(
        (await readFile(filePath, "utf8")).replace(/^\s*\/\/.*$/gmu, ""),
      ),
    ).toMatchObject({
      mcp: { a: { type: "local", command: ["a"] } },
    });

    const blockBeforeLeadingComma =
      `{"mcp":{"a":{"type":"local","command":["a"]}, /* note */ "openwiki":${entry}}}` +
      "\n";
    await writeFile(filePath, blockBeforeLeadingComma, "utf8");
    await expect(
      uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      mcp: { a: { type: "local", command: ["a"] } },
    });

    const firstWithPrecedingWhitespace =
      `{"mcp": {\n  "openwiki": ${entry} , "other":{"type":"local","command":["x"]}}}` +
      "\n";
    await writeFile(filePath, firstWithPrecedingWhitespace, "utf8");
    await expect(
      uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).resolves.toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      mcp: { other: { type: "local", command: ["x"] } },
    });
  });

  test("restores seeded config bytes after install and uninstall", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");
    for (const seeded of [
      '{"mcp":{"other":{"type":"local","command":["x"]}}}\n',
      '{"mcp": {}}\n',
      '{"mcp":{"other":{"type":"local","command":["x"]} // keep\n}}\n',
      '{"mcp":{"other":{"type":"local","command":["x"]} /* keep */}}\n',
      '{\n  // keep\n  "mcp": { "other": { "type": "local", "command": ["x"] } } // tail\n}\n',
    ]) {
      await writeFile(filePath, seeded, "utf8");
      await expect(
        installOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
      ).resolves.toBe(true);
      await expect(
        uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
      ).resolves.toBe(true);
      expect(await readFile(filePath, "utf8")).toBe(seeded);
    }

    await writeFile(
      filePath,
      '{"mcp":{"other":{"type":"local","command":["x"]},}}\n',
      "utf8",
    );
    await installOpencodeMcpEntry(filePath, OPENCODE_ENTRY);
    await uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      mcp: { other: { type: "local", command: ["x"] } },
    });

    await writeFile(filePath, '{"mcp": { /* inside */ }}\n', "utf8");
    await installOpencodeMcpEntry(filePath, OPENCODE_ENTRY);
    await uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY);
    const withComment = await readFile(filePath, "utf8");
    expect(withComment).toContain("/* inside */");
    expect(JSON.parse(withComment.replace("/* inside */", ""))).toMatchObject({
      mcp: {},
    });
  });

  test("refuses to replace an entry the user annotated with comments", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");
    const localEntry: HostMcpServerCommand = {
      command: "/opt/node/bin/node",
      args: ["/repo/dist/cli/cli.js", "mcp", "--host", "opencode"],
    };
    const commented =
      '{"mcp":{"openwiki":{"type":"local",/* keep */"command":["openwiki","mcp","--host","opencode"],"enabled":true}}}\n';
    await writeFile(filePath, commented, "utf8");

    await expect(
      installOpencodeMcpEntry(filePath, localEntry, OPENCODE_ENTRY),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(filePath, "utf8")).toBe(commented);
  });

  test("refuses to uninstall an entry the user annotated with comments", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.jsonc");
    const commented =
      '{"mcp":{"openwiki":{"type":"local","command":["openwiki","mcp","--host","opencode"],"enabled":true,// keep\n}}}\n';
    await writeFile(filePath, commented, "utf8");

    await expect(
      getOpencodeMcpEntryStatus(filePath, OPENCODE_ENTRY),
    ).resolves.toBe("modified");
    await expect(
      uninstallOpencodeMcpEntry(filePath, OPENCODE_ENTRY),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(filePath, "utf8")).toBe(commented);
  });
});
