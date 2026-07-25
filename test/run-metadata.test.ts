import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  createOpenWikiContentSnapshot,
  persistRunMetadataIfChanged,
  removeTemporaryPlanFile,
} from "../src/agent/utils.ts";
import type { OpenWikiOutputMode } from "../src/agent/types.ts";

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
    expect(metadata?.status).toBe("complete");
  });

  test("records status interrupted when a failed run persists metadata", async () => {
    const cwd = await createTempRepo();
    const snapshotBefore = await createOpenWikiContentSnapshot(
      cwd,
      "repository",
    );

    await mkdir(path.join(cwd, "openwiki"), { recursive: true });
    await writeFile(path.join(cwd, "openwiki", "index.md"), "# Docs\n", "utf8");

    const written = await persistRunMetadataIfChanged(
      "update",
      cwd,
      "test-model",
      "repository",
      snapshotBefore,
      "interrupted",
    );

    expect(written).toBe(true);
    const metadata = await readMetadata(cwd, "openwiki/.last-update.json");
    expect(metadata?.status).toBe("interrupted");
  });

  test("clears an interrupted status when a completed run changes nothing", async () => {
    const cwd = await createTempRepo();

    await mkdir(path.join(cwd, "openwiki"), { recursive: true });
    await writeFile(path.join(cwd, "openwiki", "index.md"), "# Docs\n", "utf8");
    const interruptedSnapshot = await createOpenWikiContentSnapshot(
      cwd,
      "repository",
    );
    await writeFile(
      path.join(cwd, "openwiki", "index.md"),
      "# Fixed\n",
      "utf8",
    );
    await persistRunMetadataIfChanged(
      "update",
      cwd,
      "test-model",
      "repository",
      interruptedSnapshot,
      "interrupted",
    );

    // Retry run completes without writing anything: the snapshot is
    // unchanged, but the interrupted flag must still be cleared so the
    // update no-op check can skip again.
    const retrySnapshot = await createOpenWikiContentSnapshot(
      cwd,
      "repository",
    );
    const written = await persistRunMetadataIfChanged(
      "update",
      cwd,
      "test-model",
      "repository",
      retrySnapshot,
    );

    expect(written).toBe(true);
    const metadata = await readMetadata(cwd, "openwiki/.last-update.json");
    expect(metadata?.status).toBe("complete");
  });

  test("does not rewrite metadata when nothing changed after a complete run", async () => {
    const cwd = await createTempRepo();

    await mkdir(path.join(cwd, "openwiki"), { recursive: true });
    await writeFile(path.join(cwd, "openwiki", "index.md"), "# Docs\n", "utf8");
    const snapshotBefore = await createOpenWikiContentSnapshot(
      cwd,
      "repository",
    );
    await writeFile(path.join(cwd, "openwiki", "index.md"), "# Done\n", "utf8");
    await persistRunMetadataIfChanged(
      "update",
      cwd,
      "test-model",
      "repository",
      snapshotBefore,
    );

    const unchangedSnapshot = await createOpenWikiContentSnapshot(
      cwd,
      "repository",
    );
    const written = await persistRunMetadataIfChanged(
      "update",
      cwd,
      "test-model",
      "repository",
      unchangedSnapshot,
    );

    expect(written).toBe(false);
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

  test("skips when only the temporary plan file changed", async () => {
    const cwd = await createTempRepo();
    await mkdir(path.join(cwd, "openwiki"), { recursive: true });
    await writeFile(path.join(cwd, "openwiki", "index.md"), "# Docs\n", "utf8");
    const snapshotBefore = await createOpenWikiContentSnapshot(
      cwd,
      "repository",
    );

    await writeFile(
      path.join(cwd, "openwiki", "_plan.md"),
      "# Temporary plan\n",
      "utf8",
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

describe("removeTemporaryPlanFile", () => {
  test.each([
    ["repository", path.join("openwiki", "_plan.md")],
    ["local-wiki", "_plan.md"],
  ] as const)(
    "removes the temporary plan file in %s mode",
    async (outputMode: OpenWikiOutputMode, relativePlanPath: string) => {
      const cwd = await createTempRepo();
      const planPath = path.join(cwd, relativePlanPath);
      await mkdir(path.dirname(planPath), { recursive: true });
      await writeFile(planPath, "# Temporary plan\n", "utf8");

      await expect(removeTemporaryPlanFile(cwd, outputMode)).resolves.toBe(
        true,
      );
      await expect(readFile(planPath, "utf8")).rejects.toThrow();
      await expect(removeTemporaryPlanFile(cwd, outputMode)).resolves.toBe(
        false,
      );
    },
  );
});
