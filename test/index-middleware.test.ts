import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { OpenWikiLocalShellBackend } from "../src/agent/docs-only-backend.ts";
import { synchronizeWikiIndexes } from "../src/agent/index-middleware.ts";

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

    expect(rootIndex).toContain("type: Documentation Index");
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

  test("fails clearly when a documented file lacks a description", async () => {
    const { backend } = await setup();
    await backend.write(
      "/openwiki/page.md",
      "---\ntype: Reference\ntitle: Page\n---\n",
    );

    await expect(synchronizeWikiIndexes(backend, "repository")).rejects.toThrow(
      "/openwiki/page.md lacks a non-empty YAML description.",
    );
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

  test("rejects malformed and duplicate YAML", async () => {
    for (const frontmatter of [
      "type: [unterminated\ndescription: Page",
      "type: Reference\ndescription: First\ndescription: Second",
    ]) {
      const { backend } = await setup();
      await backend.write("/openwiki/page.md", `---\n${frontmatter}\n---\n`);

      await expect(
        synchronizeWikiIndexes(backend, "repository"),
      ).rejects.toThrow(
        "/openwiki/page.md contains invalid YAML front matter:",
      );
    }
  });

  test.each(["123", "[one, two]", "{ text: nested }"])(
    "rejects a non-string YAML description: %s",
    async (description) => {
      const { backend } = await setup();
      await backend.write(
        "/openwiki/page.md",
        `---\ntype: Reference\ndescription: ${description}\n---\n`,
      );

      await expect(
        synchronizeWikiIndexes(backend, "repository"),
      ).rejects.toThrow(
        "/openwiki/page.md lacks a non-empty YAML description.",
      );
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
    ).resolves.toContain('title: "Empty"');
  });
});
