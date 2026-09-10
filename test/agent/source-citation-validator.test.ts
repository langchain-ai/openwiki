import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { OpenWikiLocalShellBackend } from "../../src/agent/docs-only-backend.ts";
import {
  extractSourceCitations,
  formatStaleSourceStamp,
  stripStaleSourceStamps,
  surveyWikiSourceCitations,
  validateWikiSourceCitations,
} from "../../src/agent/source-citation-validator.ts";

async function setupRepository(files: Record<string, string>) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-citations-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }

  const backend = new OpenWikiLocalShellBackend({
    docsOnly: true,
    outputMode: "repository",
    rootDir,
    virtualMode: true,
  });

  return { backend, rootDir };
}

describe("extractSourceCitations", () => {
  const topLevel = new Set(["src", "test"]);

  test("collects path-shaped code spans that start at a real top-level directory", () => {
    const citations = extractSourceCitations(
      "The entry point is `src/agent/index.ts` and its test is `test/agent/index.test.ts`.",
      topLevel,
    );

    expect(citations).toEqual([
      { citedPath: "src/agent/index.ts", line: 1 },
      { citedPath: "test/agent/index.test.ts", line: 1 },
    ]);
  });

  test("ignores slash-bearing spans that are not repository paths", () => {
    const citations = extractSourceCitations(
      [
        "The default model is `z-ai/glm-5.2` from `langchain-ai/openwiki`.",
        "Responses use `application/json` and live at `https://example.com/a.ts`.",
        "Config lives in `~/.openwiki/config.json` and `docs/guide.md`.",
        "A bare file name like `package.json` is not a citation.",
      ].join("\n"),
      topLevel,
    );

    expect(citations).toEqual([]);
  });

  test("ignores traversal segments", () => {
    expect(
      extractSourceCitations("See `src/../etc/passwd.txt`.", topLevel),
    ).toEqual([]);
  });

  test("skips fenced code blocks, where a path is an example not a claim", () => {
    const citations = extractSourceCitations(
      [
        "Real claim: `src/config/env.ts`.",
        "",
        "```bash",
        "cat `src/deleted/example.ts`",
        "```",
        "",
        "~~~",
        "also `src/another/example.ts`",
        "~~~",
      ].join("\n"),
      topLevel,
    );

    expect(citations).toEqual([{ citedPath: "src/config/env.ts", line: 1 }]);
  });

  test("reports the line each citation appears on", () => {
    const citations = extractSourceCitations(
      ["# Title", "", "Body cites `src/a.ts`.", "", "Later `src/b.ts`."].join(
        "\n",
      ),
      topLevel,
    );

    expect(citations).toEqual([
      { citedPath: "src/a.ts", line: 3 },
      { citedPath: "src/b.ts", line: 5 },
    ]);
  });
});

describe("validateWikiSourceCitations", () => {
  test("stamps a moved file and names where it went", async () => {
    const { backend, rootDir } = await setupRepository({
      "src/cli/commands.ts": "export const parsed = true;\n",
      "openwiki/overview.md":
        "# Overview\n\nCLI parsing lives in `src/commands.ts`.\n",
    });

    const report = await validateWikiSourceCitations(backend, "repository");

    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      citedPath: "src/commands.ts",
      line: 3,
      sourcePath: "/openwiki/overview.md",
      suggestions: ["src/cli/commands.ts"],
    });
    expect(report.stampedFiles).toEqual(["overview.md"]);

    const written = await readFile(
      path.join(rootDir, "openwiki/overview.md"),
      "utf8",
    );
    expect(written).toContain("openwiki: stale source reference");
    expect(written).toContain(
      'a file with that name is now at "src/cli/commands.ts"',
    );
    // The stamp precedes the claim it describes, leaving the prose intact.
    expect(written).toMatch(
      /<!-- openwiki: stale source reference .*-->\nCLI parsing lives in `src\/commands\.ts`\./u,
    );
  });

  test("lists every candidate when a file name is ambiguous", async () => {
    const { backend } = await setupRepository({
      "src/config/constants.ts": "export const a = 1;\n",
      "src/setup/constants.ts": "export const b = 2;\n",
      "openwiki/overview.md": "# Overview\n\nSee `src/constants.ts`.\n",
    });

    const report = await validateWikiSourceCitations(backend, "repository");

    expect(report.issues[0].suggestions).toEqual([
      "src/config/constants.ts",
      "src/setup/constants.ts",
    ]);
    expect(report.issues[0].message).toContain(
      "files with that name are now at",
    );
  });

  test("ignores a missing file that no move explains", async () => {
    // A path with no same-named file elsewhere is ambiguous: it may describe a
    // file the reader creates in their own repository or one written at
    // runtime. Reporting those would cost more trust than it is worth.
    const { backend } = await setupRepository({
      "src/keep.ts": "export const keep = 1;\n",
      "openwiki/overview.md":
        "# Overview\n\nCommit `openwiki/.yourconfig.json` in your repo.\n",
    });
    const edit = vi.spyOn(backend, "edit");

    const report = await validateWikiSourceCitations(backend, "repository");

    expect(report.citationsChecked).toBe(1);
    expect(report.issues).toEqual([]);
    expect(edit).not.toHaveBeenCalled();
  });

  test("resolves a cited dot-file that exists", async () => {
    const { backend } = await setupRepository({
      "openwiki/.last-update.json": '{"gitHead":"abc"}\n',
      "openwiki/overview.md":
        "# Overview\n\nRun metadata lives in `openwiki/.last-update.json`.\n",
    });

    const report = await validateWikiSourceCitations(backend, "repository");

    expect(report.citationsChecked).toBe(1);
    expect(report.issues).toEqual([]);
  });

  test("leaves a wiki whose citations all resolve untouched", async () => {
    const { backend } = await setupRepository({
      "src/agent/index.ts": "export const run = 1;\n",
      "openwiki/overview.md": "# Overview\n\nSee `src/agent/index.ts`.\n",
    });
    const edit = vi.spyOn(backend, "edit");

    const report = await validateWikiSourceCitations(backend, "repository");

    expect(report.issues).toEqual([]);
    expect(report.citationsChecked).toBe(1);
    expect(report.stampedFiles).toEqual([]);
    expect(edit).not.toHaveBeenCalled();
  });

  test("removes the stamp once the path is corrected", async () => {
    const { backend, rootDir } = await setupRepository({
      "src/cli/commands.ts": "export const parsed = true;\n",
      "openwiki/overview.md": [
        "# Overview",
        "",
        formatStaleSourceStamp("src/commands.ts", "source file does not exist"),
        "CLI parsing lives in `src/cli/commands.ts`.",
        "",
      ].join("\n"),
    });

    const report = await validateWikiSourceCitations(backend, "repository");

    expect(report.issues).toEqual([]);
    expect(report.stampedFiles).toEqual(["overview.md"]);

    const written = await readFile(
      path.join(rootDir, "openwiki/overview.md"),
      "utf8",
    );
    expect(written).not.toContain("openwiki: stale source reference");
  });

  test("does not accumulate stamps across repeated passes", async () => {
    const { backend, rootDir } = await setupRepository({
      "src/cli/commands.ts": "export const parsed = true;\n",
      "openwiki/overview.md": "# Overview\n\nSee `src/commands.ts`.\n",
    });

    await validateWikiSourceCitations(backend, "repository");
    const afterFirst = await readFile(
      path.join(rootDir, "openwiki/overview.md"),
      "utf8",
    );
    await validateWikiSourceCitations(backend, "repository");
    const afterSecond = await readFile(
      path.join(rootDir, "openwiki/overview.md"),
      "utf8",
    );

    expect(afterSecond).toBe(afterFirst);
    expect(
      afterSecond.match(/openwiki: stale source reference/gu),
    ).toHaveLength(1);
  });

  test("skips reserved control files", async () => {
    const { backend } = await setupRepository({
      "src/cli/keep.ts": "export const keep = 1;\n",
      "openwiki/index.md": "# Index\n\nSee `src/keep.ts`.\n",
      "openwiki/_plan.md": "# Plan\n\nSee `src/keep.ts`.\n",
    });

    const report = await validateWikiSourceCitations(backend, "repository");

    expect(report.filesScanned).toBe(0);
    expect(report.issues).toEqual([]);
  });

  test("does nothing for a personal wiki, which has no source tree", async () => {
    const { backend } = await setupRepository({
      "notes.md": "# Notes\n\nSee `src/gone.ts`.\n",
    });

    const report = await validateWikiSourceCitations(backend, "local-wiki");

    expect(report).toEqual({
      citationsChecked: 0,
      filesScanned: 0,
      issues: [],
      stampedFiles: [],
    });
  });
});

describe("surveyWikiSourceCitations", () => {
  test("reports resolving and missing citations without writing", async () => {
    const { backend, rootDir } = await setupRepository({
      "src/agent/index.ts": "export const run = 1;\n",
      "src/cli/moved.ts": "export const moved = 1;\n",
      "openwiki/overview.md":
        "# Overview\n\nSee `src/agent/index.ts` and `src/moved.ts`.\n",
    });
    const before = await readFile(
      path.join(rootDir, "openwiki/overview.md"),
      "utf8",
    );

    const pages = await surveyWikiSourceCitations(backend, "repository");

    expect(pages).toHaveLength(1);
    expect(pages[0].citedPaths).toEqual(["src/agent/index.ts", "src/moved.ts"]);
    expect(pages[0].missing.map((issue) => issue.citedPath)).toEqual([
      "src/moved.ts",
    ]);
    expect(
      await readFile(path.join(rootDir, "openwiki/overview.md"), "utf8"),
    ).toBe(before);
  });
});

describe("stripStaleSourceStamps", () => {
  test("removes only stale-source stamps", () => {
    const content = [
      "# Title",
      formatStaleSourceStamp("src/a.ts", "source file does not exist"),
      "<!-- openwiki: broken internal link [./x.md] file does not exist. -->",
      "Body.",
    ].join("\n");

    expect(stripStaleSourceStamps(content)).toBe(
      [
        "# Title",
        "<!-- openwiki: broken internal link [./x.md] file does not exist. -->",
        "Body.",
      ].join("\n"),
    );
  });
});
