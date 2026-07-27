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
import { cp } from "node:fs/promises";
import {
  createBundledSkillsSynchronizer,
  replaceSkillDirectories,
} from "../src/agent/skills.ts";

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

  test("ships mermaid diagram guidance with loader frontmatter", async () => {
    const skill = await readFile(
      path.join(process.cwd(), "skills/mermaid-diagrams/SKILL.md"),
      "utf8",
    );

    // The name/description frontmatter the skill loader keys on.
    expect(skill.startsWith("---\nname: mermaid-diagrams\n")).toBe(true);
    expect(skill).toContain("description:");
    // The label-safety detail that moved out of the system prompt.
    expect(skill.toLowerCase()).toContain("semicolons");
    expect(skill).toContain("erDiagram");
    // The exact degrade marker the post-run validator embeds, kept in sync so
    // the agent can find and repair a degraded fence.
    expect(skill).toContain("openwiki: mermaid parse failed");
  });

  test("retries a transient copy race and leaves the bundled skill complete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-skills-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const delays: number[] = [];
    let shouldRace = true;

    try {
      await mkdir(path.join(source, "example"), { recursive: true });
      await mkdir(target);
      await writeFile(path.join(source, "example", "SKILL.md"), "latest");

      await replaceSkillDirectories(source, target, {
        copyDirectory: async (from, to) => {
          if (shouldRace) {
            shouldRace = false;
            throw Object.assign(new Error("copy raced"), { code: "EEXIST" });
          }
          await cp(from, to, { recursive: true });
        },
        sleep: (delayMs) => {
          delays.push(delayMs);
          return Promise.resolve();
        },
      });

      await expect(
        readFile(path.join(target, "example", "SKILL.md"), "utf8"),
      ).resolves.toBe("latest");
      expect(delays).toEqual([25]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("serializes concurrent bundled-skill syncs in one process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-skills-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const lockPath = path.join(root, "locks", "bundled-skills.lock");
    const starts: number[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstCopyHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    try {
      await mkdir(path.join(source, "example"), { recursive: true });
      await mkdir(target);
      await writeFile(path.join(source, "example", "SKILL.md"), "latest");
      const synchronize = createBundledSkillsSynchronizer(
        source,
        target,
        lockPath,
        {
          copyDirectory: async (from, to) => {
            starts.push(Date.now());
            if (starts.length === 1) {
              await firstCopyHeld;
            }
            await cp(from, to, { recursive: true });
          },
        },
      );

      const first = synchronize();
      while (starts.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const second = synchronize();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(starts).toHaveLength(1);

      releaseFirst?.();
      await Promise.all([first, second]);
      expect(starts).toHaveLength(2);
      await expect(
        readFile(path.join(target, "example", "SKILL.md"), "utf8"),
      ).resolves.toBe("latest");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("serializes separate process synchronizers with the shared PID lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-skills-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const lockPath = path.join(root, "locks", "bundled-skills.lock");
    const starts: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstCopyHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    try {
      await mkdir(path.join(source, "example"), { recursive: true });
      await mkdir(target);
      await writeFile(path.join(source, "example", "SKILL.md"), "latest");
      const first = createBundledSkillsSynchronizer(source, target, lockPath, {
        copyDirectory: async (from, to) => {
          starts.push("first");
          await firstCopyHeld;
          await cp(from, to, { recursive: true });
        },
        lock: {
          isProcessAlive: (pid) => pid === 101,
          processId: 101,
          sleep: () => Promise.resolve(),
        },
      });
      const second = createBundledSkillsSynchronizer(source, target, lockPath, {
        copyDirectory: async (from, to) => {
          starts.push("second");
          await cp(from, to, { recursive: true });
        },
        lock: {
          isProcessAlive: (pid) => pid === 101,
          processId: 202,
          sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
        },
      });

      const firstRun = first();
      while (!starts.includes("first")) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const secondRun = second();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(starts).toEqual(["first"]);

      releaseFirst?.();
      await Promise.all([firstRun, secondRun]);
      expect(starts).toEqual(["first", "second"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
