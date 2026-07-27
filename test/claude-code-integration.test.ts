import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseCommand } from "../src/commands.ts";
import {
  renderClaudeCodeSkills,
  writeClaudeCodeSkills,
} from "../src/integrations/claude-code.ts";

describe("integration command parsing", () => {
  test("parses `integration claude` with a default target of the cwd", () => {
    expect(parseCommand(["integration", "claude"])).toEqual({
      kind: "integration",
      exitCode: 0,
      target: "claude",
      targetDir: ".",
    });
  });

  test("parses an explicit target path", () => {
    expect(parseCommand(["integration", "claude", "some/repo"])).toMatchObject({
      kind: "integration",
      targetDir: "some/repo",
    });
  });

  test("rejects a missing or unknown integration target", () => {
    expect(parseCommand(["integration"])).toMatchObject({ kind: "error" });
    expect(parseCommand(["integration", "codex"])).toMatchObject({
      kind: "error",
    });
  });

  test("rejects unknown options and extra positionals", () => {
    expect(parseCommand(["integration", "claude", "--force"])).toMatchObject({
      kind: "error",
    });
    expect(parseCommand(["integration", "claude", "a", "b"])).toMatchObject({
      kind: "error",
    });
  });
});

describe("rendered Claude Code skills", () => {
  const skills = renderClaudeCodeSkills();
  const bodies = skills.map((skill) => skill.content).join("\n");

  test("scaffolds exactly the two expected skill files", () => {
    expect(skills.map((skill) => skill.relativePath).sort()).toEqual([
      path.join(".claude", "skills", "openwiki-init", "SKILL.md"),
      path.join(".claude", "skills", "openwiki-update", "SKILL.md"),
    ]);
  });

  test("addresses the wiki with real relative paths, never OpenWiki virtual paths", () => {
    // Claude Code's tools take real paths; a leaked `/openwiki/...` virtual path
    // (correct only inside OpenWiki's own runtime) would make the agent write to
    // the filesystem root.
    expect(bodies).toContain("openwiki/quickstart.md");
    expect(bodies).not.toMatch(/\/openwiki\//);
    expect(bodies).not.toMatch(/~\/\.openwiki/);
  });

  test("does not leak OpenWiki connector or CLI-only vocabulary", () => {
    for (const term of [
      "openwiki_ingest",
      "openwiki_list_connectors",
      "read_file",
      "write_file",
      "openwiki --init",
    ]) {
      expect(bodies).not.toContain(term);
    }
  });

  test("carries the shared OKF methodology with the keyless (no-repair) tail", () => {
    expect(bodies).toContain("OKF-compliant YAML front matter");
    expect(bodies).toContain("## Backlog");
    expect(bodies).toContain("There is no post-run repair pass");
    // The OpenWiki-runtime-only wording must not appear on this surface.
    expect(bodies).not.toContain(
      "OpenWiki repairs front matter deterministically",
    );
  });

  test("keeps AGENTS.md/CLAUDE.md off-limits (the #361 duplicate-section guard)", () => {
    expect(bodies).toContain("Do not create or edit `AGENTS.md`");
    expect(bodies).toContain("<!-- OPENWIKI:START -->");
  });

  test("instructs the agent to write the CLI's out-of-band artifacts itself", () => {
    expect(bodies).toContain("openwiki/.last-update.json");
    expect(bodies).toContain('okf_version: "0.1"');
  });
});

describe("writeClaudeCodeSkills", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "owcc-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes both SKILL.md files under .claude/skills/ and nowhere else", async () => {
    const written = await writeClaudeCodeSkills(dir);
    expect(written).toHaveLength(2);
    for (const file of written) {
      expect(file.startsWith(path.join(dir, ".claude", "skills"))).toBe(true);
      const content = await readFile(file, "utf8");
      expect(content).toContain("name: openwiki-");
      expect(content.endsWith("\n")).toBe(true);
    }
  });
});
