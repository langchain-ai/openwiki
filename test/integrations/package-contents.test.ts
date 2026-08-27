import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = process.cwd();
const SKILL_ROOT = path.join(PACKAGE_ROOT, "integrations/openwiki");

/**
 * One file reported by `npm pack --dry-run --json`.
 */
interface PackedFile {
  /**
   * Package-relative POSIX path.
   */
  path: string;
}

/**
 * Package inventory reported by npm.
 */
interface PackReport {
  /**
   * Files npm would include in the published tarball.
   */
  files: PackedFile[];
}

describe("published host integration bundle", () => {
  test("packs every canonical skill file and excludes generated installation state", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "openwiki-pack-cache-"));
    try {
      const { stdout } = await execFileAsync(
        "npm",
        ["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", cache],
        { cwd: PACKAGE_ROOT, maxBuffer: 5 * 1024 * 1024 },
      );
      const reports = JSON.parse(stdout) as PackReport[];
      expect(reports).toHaveLength(1);

      const packedPaths = reports[0].files.map((file) => file.path);
      const canonicalFiles = await listFiles(SKILL_ROOT);
      for (const relative of canonicalFiles) {
        expect(packedPaths).toContain(`integrations/openwiki/${relative}`);
      }

      expect(packedPaths).toContain("package.json");
      expect(packedPaths.some((file) => path.isAbsolute(file))).toBe(false);
      expect(
        packedPaths.filter(
          (file) =>
            file.endsWith("/.openwiki-install.json") ||
            file.startsWith(".agents/") ||
            file.startsWith(".claude/") ||
            file.startsWith(".codex/") ||
            file.startsWith(".opencode/") ||
            file.startsWith(".config/") ||
            file.startsWith(".deepagents/") ||
            file.includes("staging") ||
            file.includes("rollback") ||
            file.includes("fixture"),
        ),
      ).toEqual([]);

      for (const relative of canonicalFiles) {
        const content = await readFile(path.join(SKILL_ROOT, relative), "utf8");
        expect(content).not.toContain(PACKAGE_ROOT);
      }
    } finally {
      await rm(cache, { force: true, recursive: true });
    }
  }, 20_000);
});

/**
 * Recursively lists regular files below a directory.
 *
 * @param root - Absolute directory to inventory.
 * @returns Sorted portable paths relative to the supplied directory.
 */
async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, "");
  return files.sort();

  /**
   * Visits one directory in the package-owned skill tree.
   *
   * @param directory - Absolute directory currently being visited.
   * @param relativeDirectory - Portable path relative to the skill root.
   */
  async function walk(
    directory: string,
    relativeDirectory: string,
  ): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
}
