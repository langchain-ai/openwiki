import {
  mkdir,
  mkdtemp,
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
});
