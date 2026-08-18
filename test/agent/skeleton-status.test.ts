import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  hasLeftoverSkeletonFile,
  readLastUpdate,
  writeLastUpdateMetadata,
} from "../../src/agent/utils.ts";

async function createEmptyRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-skeleton-"));
  await mkdir(path.join(repo, "openwiki"), { recursive: true });
  return repo;
}

describe("hasLeftoverSkeletonFile", () => {
  test("detects a leftover skeleton in repository output mode", async () => {
    const repo = await createEmptyRepo();
    try {
      await writeFile(
        path.join(repo, "openwiki", "_skeleton.md"),
        "# Skeleton\n",
        "utf8",
      );

      expect(await hasLeftoverSkeletonFile(repo, "repository")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("reports false once the skeleton is gone", async () => {
    const repo = await createEmptyRepo();
    try {
      await writeFile(path.join(repo, "openwiki", "index.md"), "# Wiki\n", "utf8");

      expect(await hasLeftoverSkeletonFile(repo, "repository")).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("checks the wiki root in local-wiki output mode", async () => {
    const repo = await createEmptyRepo();
    try {
      await writeFile(path.join(repo, "_skeleton.md"), "# Skeleton\n", "utf8");

      expect(await hasLeftoverSkeletonFile(repo, "local-wiki")).toBe(true);
      expect(await hasLeftoverSkeletonFile(repo, "repository")).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("writeLastUpdateMetadata ended_early round-trip", () => {
  test("persists and reads back the ended_early status", async () => {
    const repo = await createEmptyRepo();
    try {
      await writeLastUpdateMetadata(
        "init",
        repo,
        "test-model",
        "repository",
        "ended_early",
      );

      const lastUpdate = await readLastUpdate(repo, "repository");

      expect(lastUpdate?.status).toBe("ended_early");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
