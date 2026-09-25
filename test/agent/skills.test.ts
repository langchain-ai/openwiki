import {
  chmod,
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
import { describe, expect, test, vi } from "vitest";
import { replaceSkillDirectories } from "../../src/agent/skills.ts";

/**
 * Recursively grant owner-write on a tree so a read-only fixture (built to
 * mimic the Nix store / immutable container that ships bundled skills as
 * `dr-xr-xr-x` dirs and `-r--r--r--` files) can be torn down afterwards.
 */
async function restoreWritable(dir: string): Promise<void> {
  await chmod(dir, 0o755);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await restoreWritable(full);
    } else {
      await chmod(full, 0o644);
    }
  }
}

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

  test("installs read-only bundled skills (top-level read-only dir + file)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-skills-ro-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");

    try {
      await mkdir(path.join(source, "write-connector"), { recursive: true });
      await writeFile(
        path.join(source, "write-connector", "SKILL.md"),
        "bundled",
      );
      // Mimic the Nix store: read-only file inside a read-only directory.
      await chmod(path.join(source, "write-connector", "SKILL.md"), 0o444);
      await chmod(path.join(source, "write-connector"), 0o555);

      await replaceSkillDirectories(source, target);

      await expect(
        readFile(path.join(target, "write-connector", "SKILL.md"), "utf8"),
      ).resolves.toBe("bundled");
      // The atomic swap must not leave a `.write-connector-staging-*` behind.
      expect((await readdir(target)).sort()).toEqual(["write-connector"]);
    } finally {
      await restoreWritable(root);
      await rm(root, { force: true, recursive: true });
    }
  });

  test("installs read-only bundled skills with read-only nested dirs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-skills-ro-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");

    try {
      const skill = path.join(source, "write-connector");
      await mkdir(path.join(skill, "references", "deep"), { recursive: true });
      await writeFile(path.join(skill, "SKILL.md"), "bundled");
      await writeFile(path.join(skill, "references", "api.md"), "reference");
      await writeFile(
        path.join(skill, "references", "deep", "note.md"),
        "deep",
      );
      // Read-only from the leaves up, exactly how an immutable store ships it.
      await chmod(path.join(skill, "references", "deep", "note.md"), 0o444);
      await chmod(path.join(skill, "references", "deep"), 0o555);
      await chmod(path.join(skill, "references", "api.md"), 0o444);
      await chmod(path.join(skill, "references"), 0o555);
      await chmod(path.join(skill, "SKILL.md"), 0o444);
      await chmod(skill, 0o555);

      await replaceSkillDirectories(source, target);

      await expect(
        readFile(
          path.join(target, "write-connector", "references", "deep", "note.md"),
          "utf8",
        ),
      ).resolves.toBe("deep");
      // No staging residue survives, even with multiple read-only nested levels.
      expect((await readdir(target)).sort()).toEqual(["write-connector"]);
    } finally {
      await restoreWritable(root);
      await rm(root, { force: true, recursive: true });
    }
  });

  test("re-syncing read-only bundled skills is idempotent and leaves no residue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-skills-ro-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");

    try {
      await mkdir(path.join(source, "write-connector"), { recursive: true });
      await writeFile(
        path.join(source, "write-connector", "SKILL.md"),
        "bundled",
      );
      await chmod(path.join(source, "write-connector", "SKILL.md"), 0o444);
      await chmod(path.join(source, "write-connector"), 0o555);

      // Two consecutive syncs: the second must replace the first cleanly.
      await replaceSkillDirectories(source, target);
      await replaceSkillDirectories(source, target);

      await expect(
        readFile(path.join(target, "write-connector", "SKILL.md"), "utf8"),
      ).resolves.toBe("bundled");
      expect((await readdir(target)).sort()).toEqual(["write-connector"]);
    } finally {
      await restoreWritable(root);
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

describe("syncBundledSkills", () => {
  test("copies the bundled skills into the OpenWiki home", async () => {
    // openWikiSkillsDir is derived from os.homedir() at module load, so point
    // HOME (and USERPROFILE for the Windows portability job) at a throwaway home
    // and re-import both modules so the write lands in the temp tree, not the
    // developer's real ~/.openwiki.
    const home = await mkdtemp(path.join(os.tmpdir(), "openwiki-skills-home-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.resetModules();

    try {
      const { syncBundledSkills } = await import("../../src/agent/skills.ts");
      const { openWikiSkillsDir } =
        await import("../../src/config/openwiki-home.ts");

      await syncBundledSkills();

      const listDirs = async (dir: string): Promise<string[]> =>
        (await readdir(dir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();

      // The source of truth is the repo's bundled skills/ directory; the home
      // copy must reproduce exactly those skill directories.
      const bundled = await listDirs(path.join(process.cwd(), "skills"));
      const copied = await listDirs(openWikiSkillsDir);

      expect(bundled.length).toBeGreaterThan(0);
      expect(copied).toEqual(bundled);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      vi.resetModules();
      await rm(home, { force: true, recursive: true });
    }
  });
});
