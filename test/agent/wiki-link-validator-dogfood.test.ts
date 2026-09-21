import path from "node:path";
import { describe, expect, test } from "vitest";
import { OpenWikiLocalShellBackend } from "../../src/agent/docs-only-backend.ts";
import {
  formatSourceCitationIssues,
  surveyWikiSourceCitations,
} from "../../src/agent/source-citation-validator.ts";
import { validateWikiInternalLinks } from "../../src/agent/wiki-link-validator.ts";

/**
 * The repository root, two levels up from `test/agent`. These checks are only
 * meaningful when `rootDir` is the real repository: pointed anywhere else the
 * wiki walk finds no pages and every assertion passes vacuously.
 */
const repoRoot = path.resolve(import.meta.dirname, "../..");

function createBackend() {
  return new OpenWikiLocalShellBackend({
    docsOnly: true,
    outputMode: "repository",
    rootDir: repoRoot,
    virtualMode: true,
  });
}

describe("validateWikiInternalLinks dogfood", () => {
  test("accepts the repository's checked-in openwiki tree", async () => {
    const backend = createBackend();

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.filesScanned).toBeGreaterThan(0);
    expect(report.issuesFound).toBe(0);
    // Names the offending pages on failure, which the issue count cannot.
    expect(report.stampedFiles).toEqual([]);
  });
});

describe("source citation dogfood", () => {
  test("every source file the checked-in wiki cites still exists", async () => {
    const backend = createBackend();

    const pages = await surveyWikiSourceCitations(backend, "repository");
    const missing = pages.flatMap((page) => page.missing);
    const citations = pages.reduce(
      (total, page) => total + page.citedPaths.length,
      0,
    );

    expect(citations).toBeGreaterThan(0);
    expect(
      missing.length === 0 ? "" : formatSourceCitationIssues(missing),
    ).toBe("");
  });
});
