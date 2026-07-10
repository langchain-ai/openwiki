import { describe, expect, test } from "vitest";
import { buildOpenWikiTools } from "../src/agent/tools/index.ts";

const REPOSITORY_ONLY_TOOLS = [
  "openwiki_git_log",
  "openwiki_git_show",
  "openwiki_git_blame",
  "openwiki_git_status",
  "openwiki_git_diff",
  "openwiki_list_repository_files",
];

const ALWAYS_AVAILABLE_TOOLS = [
  "openwiki_list_connectors",
  "openwiki_read_raw_item",
  "openwiki_cli_help",
];

function toolNames(context: {
  cwd: string;
  outputMode: "local-wiki" | "repository";
  command: "chat" | "init" | "update";
}): string[] {
  return buildOpenWikiTools(context).map((tool) => tool.name);
}

describe("buildOpenWikiTools", () => {
  test("exposes git and repo discovery tools in repository mode", () => {
    const names = toolNames({
      cwd: "/tmp/repo",
      outputMode: "repository",
      command: "init",
    });

    for (const name of [...ALWAYS_AVAILABLE_TOOLS, ...REPOSITORY_ONLY_TOOLS]) {
      expect(names).toContain(name);
    }
  });

  test("omits git and repo discovery tools in local-wiki mode", () => {
    const names = toolNames({
      cwd: "/tmp/wiki",
      outputMode: "local-wiki",
      command: "update",
    });

    for (const name of ALWAYS_AVAILABLE_TOOLS) {
      expect(names).toContain(name);
    }
    for (const name of REPOSITORY_ONLY_TOOLS) {
      expect(names).not.toContain(name);
    }
  });

  test("never includes a generic execute tool", () => {
    for (const outputMode of ["repository", "local-wiki"] as const) {
      const names = toolNames({
        cwd: "/tmp/x",
        outputMode,
        command: "init",
      });
      expect(names).not.toContain("execute");
    }
  });
});
