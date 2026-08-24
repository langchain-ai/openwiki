import { ToolMessage } from "@langchain/core/messages";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  MUTATION_PATH_METADATA_KEY,
  OpenWikiLocalShellBackend,
} from "../../src/agent/docs-only-backend.ts";
import { createOpenWikiIndexMiddleware } from "../../src/agent/okf-middleware.ts";
import { OPENWIKI_VERSION } from "../../src/version.ts";
import { parseFrontmatterFields } from "../../src/okf/frontmatter.ts";
import { ENGLISH_INDEX_LABELS } from "../../src/okf/index-labels.ts";
import {
  migrateWikiToOkf,
  synchronizeWikiIndexes,
} from "../../src/okf/index-sync.ts";
import { describeErrorForTelemetry } from "../../src/telemetry/index.ts";

// A flowchart node named `end` is reserved, so this fence fails to parse.
const BROKEN_MERMAID = [
  "```mermaid",
  "flowchart TD",
  "  A[Start] --> end[The End]",
  "```",
].join("\n");

function document(title: string, description: string): string {
  return `---\ntype: Reference\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${title}\n`;
}

/**
 * Mirrors the stable public ID expected for one projected resource.
 */
function openWikiSourceId(resource: string): string {
  return `openwiki-source-${createHash("sha256").update(resource).digest("hex").slice(0, 24)}`;
}

async function setup(outputMode: "local-wiki" | "repository" = "repository") {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-index-"));
  const backend = new OpenWikiLocalShellBackend({
    docsOnly: true,
    outputMode,
    rootDir,
    virtualMode: true,
  });
  return { backend, rootDir };
}

/**
 * Runs the middleware's pre-agent lifecycle hook.
 */
async function runBeforeAgent(
  middleware: ReturnType<typeof createOpenWikiIndexMiddleware>,
): Promise<void> {
  const hook =
    typeof middleware.beforeAgent === "function"
      ? middleware.beforeAgent
      : middleware.beforeAgent?.hook;
  expect(hook).toBeTypeOf("function");
  await (hook as () => Promise<unknown>)();
}

/**
 * Runs the middleware's post-agent lifecycle hook.
 */
async function runAfterAgent(
  middleware: ReturnType<typeof createOpenWikiIndexMiddleware>,
): Promise<void> {
  const hook =
    typeof middleware.afterAgent === "function"
      ? middleware.afterAgent
      : middleware.afterAgent?.hook;
  expect(hook).toBeTypeOf("function");
  await (hook as () => Promise<unknown>)();
}

/**
 * Captures the error from an operation expected to reject.
 *
 * @param task - Operation whose failure should be inspected.
 * @returns Rejected value from the operation.
 */
async function captureError(task: () => Promise<unknown>): Promise<unknown> {
  let caught: unknown;
  try {
    await task();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  return caught;
}

describe("synchronizeWikiIndexes", () => {
  test("creates deterministic indexes for every directory", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/quickstart.md",
      document("Quickstart", "Start here."),
    );
    await backend.write(
      "/openwiki/architecture/overview.md",
      document("Architecture overview", "How the system is structured."),
    );

    await synchronizeWikiIndexes(backend, "repository");

    const rootIndex = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );
    const architectureIndex = await readFile(
      path.join(rootDir, "openwiki/architecture/index.md"),
      "utf8",
    );

    expect(rootIndex).toContain('okf_version: "0.2"');
    expect(rootIndex).not.toContain("type: Documentation Index");
    expect(rootIndex).not.toMatch(/^tags:/mu);
    expect(rootIndex).toContain("- [Quickstart](quickstart.md) - Start here.");
    expect(rootIndex).toContain(
      "# Directories\n\n- [architecture](architecture/)",
    );
    expect(rootIndex).not.toContain("architecture/) -");
    expect(architectureIndex).toContain(
      "- [Architecture overview](overview.md) - How the system is structured.",
    );
  });

  test("renders localized section headings when labels are supplied", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/quickstart.md",
      document("Brzi početak", "Počnite ovdje."),
    );
    await backend.write(
      "/openwiki/architecture/overview.md",
      document("Pregled", "Struktura sustava."),
    );

    await synchronizeWikiIndexes(backend, "repository", {
      files: "Datoteke",
      directories: "Direktoriji",
    });

    const rootIndex = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );

    expect(rootIndex).toContain(
      "# Datoteke\n\n- [Brzi početak](quickstart.md)",
    );
    expect(rootIndex).toContain(
      "# Direktoriji\n\n- [architecture](architecture/)",
    );
    expect(rootIndex).not.toContain("# Files");
    expect(rootIndex).not.toContain("# Directories");
  });

  test("stamps the localized concept type on a repaired page", async () => {
    const { backend, rootDir } = await setup();
    await backend.write("/openwiki/legacy.md", "# Pregled\n\nTijelo.\n");

    await synchronizeWikiIndexes(
      backend,
      "repository",
      { files: "Datoteke", directories: "Direktoriji" },
      "Referenca",
    );

    const legacy = await readFile(
      path.join(rootDir, "openwiki/legacy.md"),
      "utf8",
    );
    expect(legacy).toContain('type: "Referenca"');
    expect(legacy).not.toContain('type: "Reference"');
  });

  test("uses OKF version frontmatter only at the bundle root", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/quickstart.md",
      document("Quickstart", "Start here."),
    );
    await backend.write(
      "/openwiki/architecture/overview.md",
      document("Architecture", "System structure."),
    );

    await synchronizeWikiIndexes(backend, "repository");

    const rootIndex = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );
    const nestedIndex = await readFile(
      path.join(rootDir, "openwiki/architecture/index.md"),
      "utf8",
    );
    expect(rootIndex).toMatch(/^---\nokf_version: "0\.2"\n---\n\n# Files/mu);
    expect(rootIndex).not.toContain("type: Documentation Index");
    expect(nestedIndex).toMatch(/^# Files/mu);
    expect(nestedIndex).not.toMatch(/^---/u);
  });

  test("does not rewrite an index that is already current", async () => {
    const { backend } = await setup();
    await backend.write(
      "/openwiki/page.md",
      document("Page", "A stable page."),
    );
    await synchronizeWikiIndexes(backend, "repository");

    const edit = vi.spyOn(backend, "edit");
    await synchronizeWikiIndexes(backend, "repository");
    expect(edit).not.toHaveBeenCalled();
  });

  test("repairs stale indexes and ignores control Markdown", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/page.md",
      document("Page", "Current description."),
    );
    await backend.write("/openwiki/INSTRUCTIONS.md", "No front matter.");
    await synchronizeWikiIndexes(backend, "repository");

    const indexPath = "/openwiki/index.md";
    const current = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );
    await backend.edit(indexPath, current, "stale");
    await synchronizeWikiIndexes(backend, "repository");

    const repaired = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );
    expect(repaired).toContain("Current description.");
    expect(repaired).not.toContain("INSTRUCTIONS.md");
  });

  test("does not index the reserved OKF log document", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/page.md",
      document("Page", "Current description."),
    );
    await backend.write(
      "/openwiki/log.md",
      "# Directory Update Log\n\n## 2026-07-16\n- **Update**: Changed page.\n",
    );

    await synchronizeWikiIndexes(backend, "repository");

    const index = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );
    expect(index).not.toContain("log.md");
  });

  test("indexes a valid OKF file without an optional description", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/page.md",
      "---\ntype: Reference\ntitle: Page\n---\n",
    );

    await synchronizeWikiIndexes(backend, "repository");

    const index = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );
    expect(index).toContain("- [Page](page.md)\n");
    expect(index).not.toContain("undefined");
  });

  test("parses quoted and folded YAML descriptions", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/quoted.md",
      "---\ntype: Reference\ntitle: 'Quoted: page'\ndescription: \"A description: with a colon.\"\n---\n",
    );
    await backend.write(
      "/openwiki/folded.md",
      "---\ntype: Reference\ntitle: Folded\ndescription: >-\n  A folded\n  description.\n---\n",
    );

    await synchronizeWikiIndexes(backend, "repository");

    const index = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );
    expect(index).toContain(
      "- [Quoted: page](quoted.md) - A description: with a colon.",
    );
    expect(index).toContain("- [Folded](folded.md) - A folded description.");
  });

  test("normalizes malformed and duplicate YAML instead of throwing", async () => {
    for (const frontmatter of [
      "type: [unterminated\ndescription: Page",
      "type: Reference\ndescription: First\ndescription: Second",
    ]) {
      const { backend, rootDir } = await setup();
      await backend.write("/openwiki/page.md", `---\n${frontmatter}\n---\n`);

      await expect(
        synchronizeWikiIndexes(backend, "repository"),
      ).resolves.toBeUndefined();

      const page = await readFile(
        path.join(rootDir, "openwiki/page.md"),
        "utf8",
      );
      expect(page).toContain('type: "Reference"');
      expect(page).toContain("openwiki_generated: true");
    }
  });

  test.each([
    ["123", "[one, two]"],
    ["[one, two]", "{ text: nested }"],
    ["{ text: nested }", ""],
  ])(
    "falls back when optional title and description are not usable strings: %s / %s",
    async (title, description) => {
      const { backend, rootDir } = await setup();
      await backend.write(
        "/openwiki/page.md",
        `---\ntype: Reference\ntitle: ${title}\ndescription: ${description}\n---\n`,
      );

      await synchronizeWikiIndexes(backend, "repository");

      const index = await readFile(
        path.join(rootDir, "openwiki/index.md"),
        "utf8",
      );
      expect(index).toContain("- [page](page.md)\n");
      expect(index).not.toContain(" - ");
    },
  );

  test("supports the local wiki root and empty directories", async () => {
    const { backend, rootDir } = await setup("local-wiki");
    await backend.write(
      "/quickstart.md",
      document("Quickstart", "Start here."),
    );
    await mkdir(path.join(rootDir, "empty"));

    await synchronizeWikiIndexes(backend, "local-wiki");

    await expect(
      readFile(path.join(rootDir, "index.md"), "utf8"),
    ).resolves.toContain("- [empty](empty/)");
    await expect(
      readFile(path.join(rootDir, "empty/index.md"), "utf8"),
    ).resolves.toBe("# Files\n");
  });
});

describe("migrateWikiToOkf", () => {
  test("stamps legacy pages and leaves conformant pages untouched", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/good.md",
      document("Good", "Already conformant."),
    );
    await backend.write(
      "/openwiki/architecture/legacy.md",
      "# Legacy Page\n\nSome body.\n",
    );

    const goodBefore = await readFile(
      path.join(rootDir, "openwiki/good.md"),
      "utf8",
    );
    const edit = vi.spyOn(backend, "edit");

    await migrateWikiToOkf(backend, "repository");

    // The legacy page gains a minimal, flagged OKF block; its body survives.
    const legacy = await readFile(
      path.join(rootDir, "openwiki/architecture/legacy.md"),
      "utf8",
    );
    expect(legacy).toContain('type: "Reference"');
    expect(legacy).toContain('title: "Legacy Page"');
    expect(legacy).toContain("openwiki_generated: true");
    expect(legacy).toContain("Some body.");

    // The conformant page is never rewritten.
    expect(edit).toHaveBeenCalledTimes(1);
    await expect(
      readFile(path.join(rootDir, "openwiki/good.md"), "utf8"),
    ).resolves.toBe(goodBefore);
  });

  test("stamps a localized concept type when supplied", async () => {
    const { backend, rootDir } = await setup();
    await backend.write("/openwiki/legacy.md", "# Pregled\n\nTijelo.\n");

    await migrateWikiToOkf(backend, "repository", "Referenca");

    const legacy = await readFile(
      path.join(rootDir, "openwiki/legacy.md"),
      "utf8",
    );
    expect(legacy).toContain('type: "Referenca"');
    expect(legacy).not.toContain('type: "Reference"');
  });

  test("skips reserved files, dotfiles, and dot-directories", async () => {
    const { backend, rootDir } = await setup();
    const dir = path.join(rootDir, "openwiki");
    await mkdir(path.join(dir, ".hidden"), { recursive: true });
    for (const name of [
      "index.md",
      "log.md",
      "INSTRUCTIONS.md",
      ".secret.md",
    ]) {
      await writeFile(path.join(dir, name), "# No front matter\n\nBody.\n");
    }
    await writeFile(
      path.join(dir, ".hidden", "buried.md"),
      "# Buried\n\nBody.\n",
    );

    const edit = vi.spyOn(backend, "edit");
    await migrateWikiToOkf(backend, "repository");

    expect(edit).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(dir, "INSTRUCTIONS.md"), "utf8"),
    ).resolves.not.toContain("openwiki_generated");
  });

  test("migrates from the local-wiki root", async () => {
    const { backend, rootDir } = await setup("local-wiki");
    await backend.write("/note.md", "# Note\n\nBody.\n");

    await migrateWikiToOkf(backend, "local-wiki");

    await expect(
      readFile(path.join(rootDir, "note.md"), "utf8"),
    ).resolves.toContain("openwiki_generated: true");
  });

  test("is a no-op when the wiki root is missing", async () => {
    const { backend } = await setup("repository");

    // Nothing was written, so /openwiki does not exist.
    await expect(
      migrateWikiToOkf(backend, "repository"),
    ).resolves.toBeUndefined();
  });
});

describe("createOpenWikiIndexMiddleware beforeAgent", () => {
  test("migrates existing pages before the agent runs", async () => {
    const { backend, rootDir } = await setup();
    await backend.write("/openwiki/legacy.md", "# Legacy\n\nBody.\n");

    const middleware = createOpenWikiIndexMiddleware(backend, "repository");
    await runBeforeAgent(middleware);

    const legacy = await readFile(
      path.join(rootDir, "openwiki/legacy.md"),
      "utf8",
    );
    expect(legacy).toContain('type: "Reference"');
    expect(legacy).toContain("openwiki_generated: true");
  });

  test("migrates using the localized concept type it was created with", async () => {
    const { backend, rootDir } = await setup();
    await backend.write("/openwiki/legacy.md", "# Pregled\n\nTijelo.\n");

    const middleware = createOpenWikiIndexMiddleware(
      backend,
      "repository",
      ENGLISH_INDEX_LABELS,
      "Referenca",
    );
    await runBeforeAgent(middleware);

    const legacy = await readFile(
      path.join(rootDir, "openwiki/legacy.md"),
      "utf8",
    );
    expect(legacy).toContain('type: "Referenca"');
  });

  test("preserves migration telemetry classification", async () => {
    const { backend } = await setup();
    await backend.write("/openwiki/legacy.md", "# Legacy\n\nBody.\n");
    vi.spyOn(backend, "edit").mockResolvedValue({ error: "disk full" });

    const middleware = createOpenWikiIndexMiddleware(backend, "repository");
    const error = await captureError(() => runBeforeAgent(middleware));

    expect(describeErrorForTelemetry(error)).toMatchObject({
      errorClass: "okf_error",
      errorDetail: "migrate",
      errorStage: "build",
    });
  });
});

describe("createOpenWikiIndexMiddleware afterAgent", () => {
  test("degrades invalid mermaid and synchronizes indexes in one pass", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/quickstart.md",
      `${document("Quickstart", "Start here.")}\n${BROKEN_MERMAID}\n`,
    );

    const middleware = createOpenWikiIndexMiddleware(backend, "repository");
    await runBeforeAgent(middleware);
    await runAfterAgent(middleware);

    const page = await readFile(
      path.join(rootDir, "openwiki/quickstart.md"),
      "utf8",
    );
    const index = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );

    // The mermaid pass ran: the broken fence is now a degraded text fence.
    expect(page).toContain("```text");
    expect(page).toContain("openwiki: mermaid parse failed");
    expect(page).toContain("generated:");
    // The index pass also ran over the same tree.
    expect(index).toContain("- [Quickstart](quickstart.md) - Start here.");
  });

  test("stamps broken internal links without failing the run", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/quickstart.md",
      `${document("Quickstart", "Start here.")}\nSee [missing](./missing.md).\n`,
    );

    const middleware = createOpenWikiIndexMiddleware(backend, "repository");
    await runBeforeAgent(middleware);
    await expect(runAfterAgent(middleware)).resolves.toBeUndefined();

    const page = await readFile(
      path.join(rootDir, "openwiki/quickstart.md"),
      "utf8",
    );
    expect(page).toContain("openwiki: broken internal link [./missing.md]");
    expect(page).toContain("See [missing](./missing.md).");
    expect(page).toContain("generated:");
  });

  test("projects final Claims evidence into OKF sources", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/page.md",
      document("Page", "Grounded page."),
    );
    const middleware = createOpenWikiIndexMiddleware(
      backend,
      "repository",
      ENGLISH_INDEX_LABELS,
      "Reference",
      "2026-08-20T00:00:00.000Z",
      () =>
        new Map([
          [
            "/openwiki/page.md",
            ["repo://src/page.ts#L1-L8", "repo://package.json"],
          ],
        ]),
    );

    await runBeforeAgent(middleware);
    await runAfterAgent(middleware);

    const page = await readFile(path.join(rootDir, "openwiki/page.md"), "utf8");
    expect(parseFrontmatterFields(page)?.sources).toEqual([
      {
        id: openWikiSourceId("repo://package.json"),
        resource: "repo://package.json",
      },
      {
        id: openWikiSourceId("repo://src/page.ts"),
        resource: "repo://src/page.ts",
      },
    ]);
    expect(page).not.toContain("generated:");
  });

  test("preserves finalization telemetry classification", async () => {
    const { backend } = await setup();
    await backend.write(
      "/openwiki/quickstart.md",
      document("Quickstart", "Start here."),
    );
    const middleware = createOpenWikiIndexMiddleware(backend, "repository");
    await runBeforeAgent(middleware);

    const realWrite = backend.write.bind(backend);
    vi.spyOn(backend, "write").mockImplementation(async (filePath, content) =>
      filePath === "/openwiki/index.md"
        ? { error: "disk full" }
        : realWrite(filePath, content),
    );
    const error = await captureError(() => runAfterAgent(middleware));

    expect(describeErrorForTelemetry(error)).toMatchObject({
      errorClass: "okf_error",
      errorDetail: "index_sync",
      errorStage: "finalize",
    });
  });
});

describe("createOpenWikiIndexMiddleware generated finalization", () => {
  const NOW = "2026-08-18T09:00:00.000Z";
  const LATER = "2026-08-19T10:00:00.000Z";

  /**
   * Drives one wiki write through the middleware's wrapToolCall exactly as the
   * deepagents write tool would: the handler persists the content and returns a
   * ToolMessage carrying the mutation path the docs-only backend stamps.
   */
  async function driveWrite(
    middleware: ReturnType<typeof createOpenWikiIndexMiddleware>,
    backend: OpenWikiLocalShellBackend,
    filePath: string,
    content: string,
    toolName = "write_file",
  ) {
    const wrap = (
      typeof middleware.wrapToolCall === "function"
        ? middleware.wrapToolCall
        : middleware.wrapToolCall?.hook
    ) as (request: unknown, handler: unknown) => Promise<unknown>;
    const request = {
      toolCall: { name: toolName, args: { file_path: filePath, content } },
    };
    const handler = async () => {
      await backend.write(filePath, content);
      return new ToolMessage({
        content: "Successfully wrote file.",
        metadata: { [MUTATION_PATH_METADATA_KEY]: filePath },
        tool_call_id: "write-1",
      });
    };
    return wrap(request, handler);
  }

  test("stamps a newly created concept after its final full-file rewrite", async () => {
    const { backend, rootDir } = await setup();
    const middleware = createOpenWikiIndexMiddleware(
      backend,
      "repository",
      ENGLISH_INDEX_LABELS,
      "Reference",
      NOW,
    );
    await runBeforeAgent(middleware);

    await driveWrite(
      middleware,
      backend,
      "/openwiki/page.md",
      "---\ntype: Reference\ntitle: Page\n---\n\n# Page\n\nBody.\n",
    );
    await driveWrite(
      middleware,
      backend,
      "/openwiki/page.md",
      "---\ntype: Reference\ntitle: Page\n---\n\n# Page\n\nBody.\n",
    );

    const beforeFinalization = await readFile(
      path.join(rootDir, "openwiki/page.md"),
      "utf8",
    );
    expect(beforeFinalization).not.toContain("generated:");

    await runAfterAgent(middleware);

    const page = await readFile(path.join(rootDir, "openwiki/page.md"), "utf8");
    expect(page).toContain(
      `generated: {by: "openwiki/${OPENWIKI_VERSION}", at: "${NOW}"}`,
    );
  });

  test("bumps at and drops legacy timestamp when the body changes", async () => {
    const { backend, rootDir } = await setup();
    const middleware = createOpenWikiIndexMiddleware(
      backend,
      "repository",
      ENGLISH_INDEX_LABELS,
      "Reference",
      LATER,
    );
    // Pre-seed a legacy v0.1 page (has timestamp, no generated) directly.
    await backend.write(
      "/openwiki/page.md",
      '---\ntype: Reference\ntitle: Page\ntimestamp: "2026-07-16T20:00:00Z"\n---\n\n# Page\n\nOld body.\n',
    );
    await runBeforeAgent(middleware);

    await driveWrite(
      middleware,
      backend,
      "/openwiki/page.md",
      '---\ntype: Reference\ntitle: Page\ntimestamp: "2026-07-16T20:00:00Z"\n---\n\n# Page\n\nNew body.\n',
    );
    await runAfterAgent(middleware);

    const page = await readFile(path.join(rootDir, "openwiki/page.md"), "utf8");
    expect(page).toContain(
      `generated: {by: "openwiki/${OPENWIKI_VERSION}", at: "${LATER}"}`,
    );
    expect(page).not.toContain("timestamp:");
    // Exactly one generated event, not a duplicated field.
    expect(page.match(/^generated:/gmu)).toHaveLength(1);
  });

  test("bumps generated when only the body whitespace changes", async () => {
    const { backend, rootDir } = await setup();
    const middleware = createOpenWikiIndexMiddleware(
      backend,
      "repository",
      ENGLISH_INDEX_LABELS,
      "Reference",
      LATER,
    );
    await backend.write(
      "/openwiki/page.md",
      `---\ntype: Reference\ngenerated: {by: "openwiki/${OPENWIKI_VERSION}", at: "${NOW}"}\n---\n\n# Page\n\nSame body.\n`,
    );
    await runBeforeAgent(middleware);

    // A full-file rewrite omits the code-owned field and only reflows body
    // whitespace. That is still a body change and must advance the event.
    await driveWrite(
      middleware,
      backend,
      "/openwiki/page.md",
      "---\ntype: Reference\n---\n\n#   Page\n\n\nSame   body.\n",
    );
    await runAfterAgent(middleware);

    const page = await readFile(path.join(rootDir, "openwiki/page.md"), "utf8");
    expect(page).toContain(`at: "${LATER}"`);
    expect(page).not.toContain(NOW);
  });

  test("does not bump generated when only front matter changes", async () => {
    const { backend, rootDir } = await setup();
    const middleware = createOpenWikiIndexMiddleware(
      backend,
      "repository",
      ENGLISH_INDEX_LABELS,
      "Reference",
      LATER,
    );
    await backend.write(
      "/openwiki/page.md",
      `---\ntype: Reference\ngenerated: {by: "openwiki/${OPENWIKI_VERSION}", at: "${NOW}"}\n---\n\n# Page\n\nSame body.\n`,
    );
    await runBeforeAgent(middleware);

    await driveWrite(
      middleware,
      backend,
      "/openwiki/page.md",
      "---\ntype: Guide\ntitle: Page\n---\n\n# Page\n\nSame body.\n",
    );
    await runAfterAgent(middleware);

    const page = await readFile(path.join(rootDir, "openwiki/page.md"), "utf8");
    expect(page).toContain(`at: "${NOW}"`);
    expect(page).not.toContain(LATER);
    expect(page).toContain("type: Guide");
  });

  test("stamps a nested concept but never a reserved document", async () => {
    const { backend, rootDir } = await setup();
    const middleware = createOpenWikiIndexMiddleware(
      backend,
      "repository",
      ENGLISH_INDEX_LABELS,
      "Reference",
      NOW,
    );
    await runBeforeAgent(middleware);

    await driveWrite(
      middleware,
      backend,
      "/openwiki/notes/scratch.md",
      "---\ntype: Reference\n---\n\n# Scratch\n\nBody.\n",
    );
    await driveWrite(
      middleware,
      backend,
      "/openwiki/log.md",
      "# Directory Update Log\n\n## 2026-08-18\n- Changed page.\n",
    );
    await runAfterAgent(middleware);

    const nested = await readFile(
      path.join(rootDir, "openwiki/notes/scratch.md"),
      "utf8",
    );
    expect(nested).toContain(`at: "${NOW}"`);

    const log = await readFile(path.join(rootDir, "openwiki/log.md"), "utf8");
    expect(log).not.toContain("generated:");
  });

  test("does not stamp a non-Markdown file written under the wiki", async () => {
    const { backend, rootDir } = await setup();
    const middleware = createOpenWikiIndexMiddleware(
      backend,
      "repository",
      ENGLISH_INDEX_LABELS,
      "Reference",
      NOW,
    );
    await runBeforeAgent(middleware);

    await driveWrite(
      middleware,
      backend,
      "/openwiki/data.json",
      '{"stamped": false}\n',
    );
    await runAfterAgent(middleware);

    const data = await readFile(
      path.join(rootDir, "openwiki/data.json"),
      "utf8",
    );
    expect(data).not.toContain("generated:");
  });

  test("leaves a preserved unstamped page unstamped", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/page.md",
      "---\ntype: Reference\n---\n\n# Page\n\nStable body.\n",
    );
    const middleware = createOpenWikiIndexMiddleware(
      backend,
      "repository",
      ENGLISH_INDEX_LABELS,
      "Reference",
      NOW,
    );

    await runBeforeAgent(middleware);
    await runAfterAgent(middleware);

    const page = await readFile(path.join(rootDir, "openwiki/page.md"), "utf8");
    expect(page).not.toContain("generated:");
  });

  test("fails finalization when the generated event cannot be persisted", async () => {
    const { backend, rootDir } = await setup();
    const middleware = createOpenWikiIndexMiddleware(
      backend,
      "repository",
      ENGLISH_INDEX_LABELS,
      "Reference",
      NOW,
    );
    await runBeforeAgent(middleware);

    const body = "---\ntype: Reference\ntitle: Page\n---\n\n# Page\n\nBody.\n";
    await driveWrite(middleware, backend, "/openwiki/page.md", body);

    const realWrite = backend.write.bind(backend);
    const writeSpy = vi
      .spyOn(backend, "write")
      .mockImplementation(async (p: string, c: string) => {
        return p === "/openwiki/page.md" && c.includes("generated:")
          ? { error: "disk full" }
          : realWrite(p, c);
      });

    try {
      await expect(runAfterAgent(middleware)).rejects.toThrow(
        "Unable to finalize generated provenance for /openwiki/page.md: disk full",
      );
    } finally {
      writeSpy.mockRestore();
    }

    // The model-authored content survives, but the run cannot claim successful
    // finalization while its code-owned provenance is absent.
    const page = await readFile(path.join(rootDir, "openwiki/page.md"), "utf8");
    expect(page).toBe(body);
    expect(page).not.toContain("generated:");
  });
});
