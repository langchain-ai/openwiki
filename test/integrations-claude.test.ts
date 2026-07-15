import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { writeClaudeIntegration } from "../src/integrations/claude.ts";

const tempRepos: string[] = [];

async function createTempRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-integration-"));
  tempRepos.push(repo);
  return repo;
}

function skillPath(repo: string, skill: string): string {
  return path.join(repo, ".claude", "skills", skill, "SKILL.md");
}

afterEach(async () => {
  await Promise.all(
    tempRepos
      .splice(0)
      .map((repo) => rm(repo, { force: true, recursive: true })),
  );
});

describe("writeClaudeIntegration", () => {
  test("writes both skill files under .claude/skills", async () => {
    const repo = await createTempRepo();

    const result = await writeClaudeIntegration(repo);

    const initPath = skillPath(repo, "openwiki-init");
    const updatePath = skillPath(repo, "openwiki-update");
    expect(result.writtenFiles).toContain(initPath);
    expect(result.writtenFiles).toContain(updatePath);
    expect((await stat(initPath)).isFile()).toBe(true);
    expect((await stat(updatePath)).isFile()).toBe(true);
    expect(result.targetDir).toBe(path.resolve(repo));
  });

  test("skill frontmatter is valid and body uses Claude-native tools", async () => {
    const repo = await createTempRepo();

    await writeClaudeIntegration(repo);

    for (const skill of ["openwiki-init", "openwiki-update"]) {
      const content = await readFile(skillPath(repo, skill), "utf8");

      // Frontmatter carries a valid Claude Code skill header.
      expect(content.startsWith("---\n")).toBe(true);
      expect(content).toContain(`name: ${skill}`);
      expect(content).toContain("description:");
      expect(content).toContain("user-invocable: true");
      expect(content).toContain("disable-model-invocation: false");
      // Quoted so the leading "[" is not parsed as a YAML flow sequence.
      expect(content).toContain('argument-hint: "[path-to-repository]"');

      // Tool vocabulary is remapped to Claude Code natives.
      for (const tool of ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]) {
        expect(content).toContain(tool);
      }

      // Real relative paths, never the virtual filesystem root.
      expect(content).toContain("openwiki/quickstart.md");
      expect(content).toContain("openwiki/.last-update.json");

      // Connector-only and legacy-tool text is stripped.
      expect(content).not.toContain("openwiki_ingest_connector");
      expect(content).not.toContain("read_file");
      expect(content).not.toContain("write_file");
      expect(content).not.toContain("~/.openwiki/wiki");
      expect(content).not.toContain("/openwiki/");
    }
  });

  test("both skills keep every core discipline section", async () => {
    const repo = await createTempRepo();

    await writeClaudeIntegration(repo);

    // Drift guard: the skill bodies are a hand-maintained port of the
    // repository-mode instructions in src/agent/prompt.ts. If a future re-port
    // drops one of these disciplines, this fails so the omission is noticed.
    const sharedSections = [
      "## Run discipline",
      "## Subagent discipline",
      "## Planning discipline",
      "## Git discipline",
      "## Existing documentation discipline",
      "## Security and privacy rules",
      "## Documentation goals",
      "## Section quality rules",
      "## Required documentation structure",
      "## Coverage self-check",
    ];

    for (const skill of ["openwiki-init", "openwiki-update"]) {
      const content = await readFile(skillPath(repo, skill), "utf8");
      for (const section of sharedSections) {
        expect(content, `${skill} should keep ${section}`).toContain(section);
      }
    }

    const init = await readFile(skillPath(repo, "openwiki-init"), "utf8");
    const update = await readFile(skillPath(repo, "openwiki-update"), "utf8");
    expect(init).toContain("## Initial run specifics");
    expect(update).toContain("## Update run specifics");
  });

  test("init and update carry their own command instructions", async () => {
    const repo = await createTempRepo();

    await writeClaudeIntegration(repo);

    const init = await readFile(skillPath(repo, "openwiki-init"), "utf8");
    const update = await readFile(skillPath(repo, "openwiki-update"), "utf8");
    expect(init).toContain('"command": "init"');
    expect(update).toContain('"command": "update"');
    // The update skill is the one that must stay surgical.
    expect(update).toContain("surgical");
  });

  test("is idempotent across repeated runs", async () => {
    const repo = await createTempRepo();

    await writeClaudeIntegration(repo);
    const firstInit = await readFile(skillPath(repo, "openwiki-init"), "utf8");
    const firstUpdate = await readFile(
      skillPath(repo, "openwiki-update"),
      "utf8",
    );

    await writeClaudeIntegration(repo);
    const secondInit = await readFile(skillPath(repo, "openwiki-init"), "utf8");
    const secondUpdate = await readFile(
      skillPath(repo, "openwiki-update"),
      "utf8",
    );

    expect(secondInit).toEqual(firstInit);
    expect(secondUpdate).toEqual(firstUpdate);
  });

  test("rejects a non-existent target directory", async () => {
    const repo = await createTempRepo();
    const missing = path.join(repo, "does-not-exist");

    await expect(writeClaudeIntegration(missing)).rejects.toThrow(
      /does not exist/u,
    );
  });
});
