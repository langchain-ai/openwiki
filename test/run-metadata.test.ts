import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  createOpenWikiContentSnapshot,
  persistRunMetadataIfChanged,
} from "../src/agent/utils.ts";

async function createTempRepo(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "openwiki-run-metadata-"));
}

async function readMetadata(
  cwd: string,
  metadataPath: string,
): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(
      await readFile(path.join(cwd, metadataPath), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe("persistRunMetadataIfChanged", () => {
  test("writes metadata when wiki content changed since the snapshot", async () => {
    const cwd = await createTempRepo();
    const snapshotBefore = await createOpenWikiContentSnapshot(
      cwd,
      "repository",
    );

    await mkdir(path.join(cwd, "openwiki"), { recursive: true });
    await writeFile(path.join(cwd, "openwiki", "index.md"), "# Docs\n", "utf8");

    const written = await persistRunMetadataIfChanged(
      "init",
      cwd,
      "test-model",
      "repository",
      snapshotBefore,
    );

    expect(written).toBe(true);
    const metadata = await readMetadata(cwd, "openwiki/.last-update.json");
    expect(metadata).not.toBeNull();
    expect(metadata?.command).toBe("init");
    expect(metadata?.model).toBe("test-model");
  });

  test("writes metadata in local-wiki mode when content changed", async () => {
    const cwd = await createTempRepo();
    const snapshotBefore = await createOpenWikiContentSnapshot(
      cwd,
      "local-wiki",
    );

    await writeFile(path.join(cwd, "index.md"), "# Wiki\n", "utf8");

    const written = await persistRunMetadataIfChanged(
      "update",
      cwd,
      "test-model",
      "local-wiki",
      snapshotBefore,
    );

    expect(written).toBe(true);
    expect(await readMetadata(cwd, ".last-update.json")).not.toBeNull();
  });

  test("skips when wiki content is unchanged", async () => {
    const cwd = await createTempRepo();
    const snapshotBefore = await createOpenWikiContentSnapshot(
      cwd,
      "repository",
    );

    const written = await persistRunMetadataIfChanged(
      "update",
      cwd,
      "test-model",
      "repository",
      snapshotBefore,
    );

    expect(written).toBe(false);
    expect(await readMetadata(cwd, "openwiki/.last-update.json")).toBeNull();
  });

  test("skips for chat runs", async () => {
    const cwd = await createTempRepo();

    const written = await persistRunMetadataIfChanged(
      "chat",
      cwd,
      "test-model",
      "repository",
      null,
    );

    expect(written).toBe(false);
    expect(await readMetadata(cwd, "openwiki/.last-update.json")).toBeNull();
  });
});
