import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
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

  test("serializes concurrent skill replacements", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-skills-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");

    try {
      await mkdir(path.join(source, "first"), { recursive: true });
      await mkdir(path.join(source, "second"));
      await writeFile(path.join(source, "first", "SKILL.md"), "first");
      await writeFile(path.join(source, "second", "SKILL.md"), "second");

      await Promise.all(
        Array.from({ length: 25 }, () =>
          replaceSkillDirectories(source, target),
        ),
      );

      await expect(
        readFile(path.join(target, "first", "SKILL.md"), "utf8"),
      ).resolves.toBe("first");
      await expect(
        readFile(path.join(target, "second", "SKILL.md"), "utf8"),
      ).resolves.toBe("second");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("recovers an abandoned skill sync lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-skills-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const lock = path.join(target, ".openwiki-skill-sync.lock");

    try {
      await mkdir(path.join(source, "existing"), { recursive: true });
      await mkdir(lock, { recursive: true });
      await writeFile(path.join(source, "existing", "SKILL.md"), "latest");
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(lock, staleTime, staleTime);

      await replaceSkillDirectories(source, target);

      await expect(
        readFile(path.join(target, "existing", "SKILL.md"), "utf8"),
      ).resolves.toBe("latest");
      await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("ships OKF migration guidance that preserves valid extensions", async () => {
    const skill = await readFile(
      path.join(process.cwd(), "skills/migrate-wiki-to-okf/SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("Preserve all valid existing front matter fields");
    expect(skill).toContain("`index.md` and `log.md` are reserved");
    expect(skill).toContain("timestamp: <Optional ISO 8601 datetime>");
    expect(skill).not.toContain("Never add `timestamp`");
    expect(skill).not.toContain("fields outside this formatter");
  });
});
