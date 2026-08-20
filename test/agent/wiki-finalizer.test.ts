import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { OpenWikiLocalShellBackend } from "../../src/agent/docs-only-backend.ts";
import {
  finalizeWikiArtifacts,
  prepareWikiForAuthoring,
  type WikiFinalizerOperation,
  type WikiFinalizerOperationRunner,
  type WikiPreparationOperation,
  type WikiPreparationOperationRunner,
} from "../../src/agent/wiki-finalizer.ts";

const RUN_TIMESTAMP = "2026-08-19T18:30:00.000Z";

const BROKEN_MERMAID = [
  "```mermaid",
  "flowchart TD",
  "  A[Start] --> end[The End]",
  "```",
].join("\n");

/**
 * Test wiki rooted in an isolated temporary repository.
 */
interface TestWiki {
  /**
   * Backend used by deterministic lifecycle operations.
   */
  backend: OpenWikiLocalShellBackend;

  /**
   * Real filesystem root used for persisted-content assertions.
   */
  rootDir: string;
}

/**
 * Creates an isolated repository-mode wiki backend.
 *
 * @returns Temporary backend and its real filesystem root.
 */
async function setupWiki(): Promise<TestWiki> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-finalizer-"));
  return {
    backend: new OpenWikiLocalShellBackend({
      docsOnly: true,
      outputMode: "repository",
      rootDir,
      virtualMode: true,
    }),
    rootDir,
  };
}

describe("prepareWikiForAuthoring", () => {
  test("migrates before capturing provenance and preserves operation details", async () => {
    const { backend } = await setupWiki();
    await backend.write("/openwiki/legacy.md", "# Pregled\n\nTijelo.\n");

    const operations: WikiPreparationOperation[] = [];
    let contentBeforeSnapshot: string | undefined;
    const runOperation: WikiPreparationOperationRunner = async (
      operation,
      task,
    ) => {
      operations.push(operation);
      if (operation === "provenance_snapshot") {
        const read = await backend.readRaw("/openwiki/legacy.md");
        contentBeforeSnapshot = read.data?.content as string | undefined;
      }
      return task();
    };

    const prepared = await prepareWikiForAuthoring({
      backend,
      outputMode: "repository",
      conceptType: "Referenca",
      runOperation,
    });

    expect(operations).toEqual(["migrate", "provenance_snapshot"]);
    expect(contentBeforeSnapshot).toContain('type: "Referenca"');
    expect(contentBeforeSnapshot).toContain("openwiki_generated: true");
    expect(prepared.generatedProvenance.has("/openwiki/legacy.md")).toBe(true);
  });
});

describe("finalizeWikiArtifacts", () => {
  test("rejects an empty producer before running finalization operations", async () => {
    const { backend } = await setupWiki();
    const prepared = await prepareWikiForAuthoring({
      backend,
      outputMode: "repository",
    });
    const operations: WikiFinalizerOperation[] = [];

    await expect(
      finalizeWikiArtifacts({
        backend,
        outputMode: "repository",
        prepared,
        at: RUN_TIMESTAMP,
        producerActor: "   ",
        runOperation: async (operation, task) => {
          operations.push(operation);
          return task();
        },
      }),
    ).rejects.toThrow("Wiki finalization requires a non-empty producer actor.");
    expect(operations).toEqual([]);
  });

  test("runs finalization operations in internal-agent order", async () => {
    const { backend } = await setupWiki();
    const prepared = await prepareWikiForAuthoring({
      backend,
      outputMode: "repository",
    });
    const operations: WikiFinalizerOperation[] = [];
    const runOperation: WikiFinalizerOperationRunner = async (
      operation,
      task,
    ) => {
      operations.push(operation);
      return task();
    };

    await finalizeWikiArtifacts({
      backend,
      outputMode: "repository",
      prepared,
      at: RUN_TIMESTAMP,
      runOperation,
    });

    expect(operations).toEqual([
      "mermaid",
      "index_sync",
      "link_validation",
      "generated_provenance",
    ]);
  });

  test("uses direct runners to repair and reconcile the authored wiki", async () => {
    const { backend, rootDir } = await setupWiki();
    const prepared = await prepareWikiForAuthoring({
      backend,
      outputMode: "repository",
    });
    await backend.write(
      "/openwiki/quickstart.md",
      [
        "---",
        "type: Guide",
        "title: Quickstart",
        "description: Start here.",
        "---",
        "",
        "# Quickstart",
        "",
        BROKEN_MERMAID,
        "",
        "See [missing](./missing.md).",
        "",
      ].join("\n"),
    );

    await finalizeWikiArtifacts({
      backend,
      outputMode: "repository",
      prepared,
      at: RUN_TIMESTAMP,
      producerActor: "host-agent/test",
    });

    const page = await readFile(
      path.join(rootDir, "openwiki/quickstart.md"),
      "utf8",
    );
    const index = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );
    expect(page).toContain("openwiki: mermaid parse failed");
    expect(page).toContain("```text");
    expect(page).toContain("openwiki: broken internal link [./missing.md]");
    expect(page).toContain(
      `generated: {by: "host-agent/test", at: "${RUN_TIMESTAMP}"}`,
    );
    expect(index).toContain("[Quickstart](quickstart.md) - Start here.");
  });

  test("preserves the prior producer when a host run leaves the body unchanged", async () => {
    const { backend, rootDir } = await setupWiki();
    const previousTimestamp = "2026-08-18T10:00:00.000Z";
    await backend.write(
      "/openwiki/existing.md",
      [
        "---",
        "type: Guide",
        `generated: {by: "openwiki/0.3.2", at: "${previousTimestamp}"}`,
        "---",
        "",
        "# Existing",
        "",
        "Unchanged body.",
        "",
      ].join("\n"),
    );
    const prepared = await prepareWikiForAuthoring({
      backend,
      outputMode: "repository",
    });

    await finalizeWikiArtifacts({
      backend,
      outputMode: "repository",
      prepared,
      at: RUN_TIMESTAMP,
      producerActor: "host-agent/codex",
    });

    const page = await readFile(
      path.join(rootDir, "openwiki/existing.md"),
      "utf8",
    );
    expect(page).toContain(
      `generated: {by: "openwiki/0.3.2", at: "${previousTimestamp}"}`,
    );
    expect(page).not.toContain("host-agent/codex");
    expect(page).not.toContain(RUN_TIMESTAMP);
  });
});
