import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { OpenWikiLocalShellBackend } from "../src/agent/docs-only-backend.ts";
import { createOpenWikiIndexMiddleware } from "../src/agent/okf-middleware.ts";
import {
  migrateWikiToOkf,
  synchronizeWikiIndexes,
} from "../src/okf/index-sync.ts";

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

    expect(rootIndex).toContain('okf_version: "0.1"');
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
    expect(rootIndex).toMatch(/^---\nokf_version: "0\.1"\n---\n\n# Files/mu);
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
    await backend.write("/openwiki/_plan.md", "Temporary plan.");
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
    expect(repaired).not.toContain("_plan.md");
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

  test("skips reserved files, dotfiles, and dot-directories", async () => {
    const { backend, rootDir } = await setup();
    const dir = path.join(rootDir, "openwiki");
    await mkdir(path.join(dir, ".hidden"), { recursive: true });
    for (const name of [
      "index.md",
      "log.md",
      "_plan.md",
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
    const beforeAgent =
      typeof middleware.beforeAgent === "function"
        ? middleware.beforeAgent
        : middleware.beforeAgent?.hook;
    expect(beforeAgent).toBeTypeOf("function");
    await (beforeAgent as () => Promise<unknown>)();

    const legacy = await readFile(
      path.join(rootDir, "openwiki/legacy.md"),
      "utf8",
    );
    expect(legacy).toContain('type: "Reference"');
    expect(legacy).toContain("openwiki_generated: true");
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
    const afterAgent =
      typeof middleware.afterAgent === "function"
        ? middleware.afterAgent
        : middleware.afterAgent?.hook;
    expect(afterAgent).toBeTypeOf("function");
    await (afterAgent as () => Promise<unknown>)();

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
    // The index pass also ran over the same tree.
    expect(index).toContain("- [Quickstart](quickstart.md) - Start here.");
  });
});
