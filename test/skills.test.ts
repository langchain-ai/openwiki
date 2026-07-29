import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { replaceSkillDirectories } from "../src/agent/skills.ts";

describe("replaceSkillDirectories", () => {
  test("overwrites bundled skills and preserves unrelated skills", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-skills-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");

    try {
      await mkdir(path.join(source, "existing"), { recursive: true });
      await mkdir(path.join(source, "blocked"));
      await mkdir(path.join(target, "existing"), { recursive: true });
      await mkdir(path.join(target, "custom"));
      await writeFile(path.join(source, "existing", "SKILL.md"), "latest");
      await writeFile(path.join(source, "blocked", "SKILL.md"), "replaced");
      await writeFile(path.join(target, "existing", "SKILL.md"), "stale");
      await writeFile(path.join(target, "blocked"), "blocking file");
      await writeFile(path.join(target, "custom", "SKILL.md"), "custom");

      await replaceSkillDirectories(source, target);

      await expect(
        readFile(path.join(target, "existing", "SKILL.md"), "utf8"),
      ).resolves.toBe("latest");
      await expect(
        readFile(path.join(target, "blocked", "SKILL.md"), "utf8"),
      ).resolves.toBe("replaced");
      expect((await stat(path.join(target, "blocked"))).isDirectory()).toBe(
        true,
      );
      await expect(
        readFile(path.join(target, "custom", "SKILL.md"), "utf8"),
      ).resolves.toBe("custom");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("succeeds when skill directories already exist, even when syncs overlap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-skills-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const skillNames = ["mermaid-diagrams", "write-connector"];

    try {
      for (const name of skillNames) {
        await mkdir(path.join(source, name), { recursive: true });
        await writeFile(path.join(source, name, "SKILL.md"), `bundled ${name}`);
        // Simulate the leftovers of an earlier `--init` run (#499).
        await mkdir(path.join(target, name), { recursive: true });
        await writeFile(path.join(target, name, "SKILL.md"), "stale");
      }

      // Re-running init over existing skill directories must not throw.
      await replaceSkillDirectories(source, target);
      await replaceSkillDirectories(source, target);

      // A doubly-triggered sync must not race into EEXIST (#499).
      for (let iteration = 0; iteration < 25; iteration += 1) {
        await Promise.all([
          replaceSkillDirectories(source, target),
          replaceSkillDirectories(source, target),
        ]);
      }

      for (const name of skillNames) {
        await expect(
          readFile(path.join(target, name, "SKILL.md"), "utf8"),
        ).resolves.toBe(`bundled ${name}`);
      }
      // Only the bundled skills remain; no staging leftovers.
      expect((await readdir(target)).sort()).toEqual(skillNames);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("ships mermaid diagram guidance with loader frontmatter", async () => {
    const skill = await readFile(
      path.join(process.cwd(), "skills/mermaid-diagrams/SKILL.md"),
      "utf8",
    );
    const normalizedSkill = skill.replace(/\r\n/gu, "\n");

    // The name/description frontmatter the skill loader keys on.
    expect(normalizedSkill.startsWith("---\nname: mermaid-diagrams\n")).toBe(
      true,
    );
    expect(normalizedSkill).toContain("description:");
    // The label-safety detail that moved out of the system prompt.
    expect(normalizedSkill.toLowerCase()).toContain("semicolons");
    expect(normalizedSkill).toContain("erDiagram");
    // The exact degrade marker the post-run validator embeds, kept in sync so
    // the agent can find and repair a degraded fence.
    expect(normalizedSkill).toContain("openwiki: mermaid parse failed");
  });
});
