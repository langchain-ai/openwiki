import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createOpenWikiContentSnapshot,
  persistRunMetadataIfChanged,
} from "../src/agent/utils.ts";
import { OpenWikiLocalShellBackend } from "../src/agent/docs-only-backend.ts";
import { synchronizeWikiIndexes } from "../src/okf/index-sync.ts";
import {
  readWorkspacesState,
  writeWorkspacesState,
} from "../src/monorepo/workspaces.ts";

const tempDirs: string[] = [];

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "openwiki-wsstate-"));
  tempDirs.push(repo);
  await mkdir(path.join(repo, "openwiki"), { recursive: true });
  await writeFile(
    path.join(repo, "openwiki", "quickstart.md"),
    `---\ntype: Reference\ntitle: Quickstart\ndescription: Root.\n---\n\n# Quickstart\n`,
    "utf8",
  );
  return repo;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe(".workspaces-state.json exclusion", () => {
  test("does not change the content snapshot (no spurious metadata writes)", async () => {
    const repo = await createRepo();
    const before = await createOpenWikiContentSnapshot(repo, "repository");

    await writeWorkspacesState(repo, {
      version: 1,
      workspaces: { "packages/a": { gitHead: "abc", updatedAt: "now" } },
    });

    const after = await createOpenWikiContentSnapshot(repo, "repository");
    expect(after).toBe(before);

    // And persistRunMetadataIfChanged treats the wiki as unchanged.
    const written = await persistRunMetadataIfChanged(
      "update",
      repo,
      "test-model",
      "repository",
      before,
    );
    expect(written).toBe(false);
  });

  test("is not linked into the generated openwiki/index.md", async () => {
    const repo = await createRepo();
    await writeWorkspacesState(repo, {
      version: 1,
      workspaces: { "packages/a": { gitHead: "abc", updatedAt: "now" } },
    });
    // The manifest sibling must also be excluded.
    await writeFile(
      path.join(repo, "openwiki", "workspaces.json"),
      JSON.stringify({ version: 1, workspaces: [{ path: "packages/a" }] }),
      "utf8",
    );

    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      outputMode: "repository",
      rootDir: repo,
      virtualMode: true,
    });
    await synchronizeWikiIndexes(backend, "repository");

    const index = await readFile(
      path.join(repo, "openwiki", "index.md"),
      "utf8",
    );
    expect(index).not.toContain(".workspaces-state.json");
    expect(index).not.toContain("workspaces.json");
  });

  test("read/write round-trips per-subproject gitHead", async () => {
    const repo = await createRepo();
    expect((await readWorkspacesState(repo)).workspaces).toEqual({});

    await writeWorkspacesState(repo, {
      version: 1,
      workspaces: {
        "packages/a": {
          gitHead: "deadbeef",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    });

    const state = await readWorkspacesState(repo);
    expect(state.workspaces["packages/a"].gitHead).toBe("deadbeef");
  });
});
