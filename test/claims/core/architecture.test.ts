import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Import layers that the generic Claims core must never depend on.
 */
const FORBIDDEN_CORE_IMPORT =
  /from\s+["'][^"']*(?:\/brains\/|\/evidence\/|\/agent\/)[^"']*["']/u;

/**
 * Code-brain policy path that generic repository evidence must not import.
 */
const CODE_BRAIN_IMPORT = /from\s+["'][^"']*\/brains\/code\/[^"']*["']/u;

describe("Claims core architecture", () => {
  test("does not import evidence, brain, or agent implementations", async () => {
    const coreDirectory = path.resolve("src/claims/core");
    const files = (await readdir(coreDirectory))
      .filter((file) => file.endsWith(".ts"))
      .sort();

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await readFile(path.join(coreDirectory, file), "utf8");
      expect(source, file).not.toMatch(FORBIDDEN_CORE_IMPORT);
    }
  });

  test("keeps repository evidence independent from code-brain policy", async () => {
    const repositoryDirectory = path.resolve("src/claims/evidence/repository");
    const files = (await readdir(repositoryDirectory))
      .filter((file) => file.endsWith(".ts"))
      .sort();

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(
        path.join(repositoryDirectory, file),
        "utf8",
      );
      expect(source, file).not.toMatch(CODE_BRAIN_IMPORT);
    }
  });
});
