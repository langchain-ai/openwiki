import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { OpenWikiLocalShellBackend } from "../src/agent/docs-only-backend.ts";
import {
  migrateWikiToOkf,
  synchronizeWikiIndexes,
} from "../src/okf/index-sync.ts";
import { writeRootAggregation } from "../src/monorepo/orchestrator.ts";
import { resolveWorkspaceRuns } from "../src/monorepo/workspaces.ts";

const tempDirs: string[] = [];

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "openwiki-agg-"));
  tempDirs.push(repo);
  await mkdir(path.join(repo, "packages", "a"), { recursive: true });
  return repo;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("workspaces.md aggregation + index sync (F3)", () => {
  test("workspaces.md is linked into the root openwiki/index.md", async () => {
    const repo = await createRepo();
    // A root quickstart so the root wiki has a normal page too.
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    await writeFile(
      path.join(repo, "openwiki", "quickstart.md"),
      `---\ntype: Reference\ntitle: Quickstart\ndescription: Root.\n---\n\n# Quickstart\n`,
      "utf8",
    );

    const plan = resolveWorkspaceRuns(repo, {
      version: 1,
      workspaces: [{ path: "packages/a", name: "Alpha" }],
    });
    await writeRootAggregation(repo, plan);

    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      outputMode: "repository",
      rootDir: repo,
      virtualMode: true,
    });

    // migrateWikiToOkf (beforeAgent) must not rewrite the generated page's type.
    await migrateWikiToOkf(backend, "repository");
    const afterMigrate = await readFile(
      path.join(repo, "openwiki", "workspaces.md"),
      "utf8",
    );
    expect(afterMigrate).toMatch(/type: Reference/);
    expect(afterMigrate).not.toContain("openwiki_generated");

    // synchronizeWikiIndexes (afterAgent) links workspaces.md into index.md.
    await synchronizeWikiIndexes(backend, "repository");
    const rootIndex = await readFile(
      path.join(repo, "openwiki", "index.md"),
      "utf8",
    );
    expect(rootIndex).toContain("workspaces.md");
  });
});
