import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { OpenWikiLocalShellBackend } from "../src/agent/docs-only-backend.ts";
import {
  formatBrokenLinkStamp,
  formatWikiLinkIssues,
  stampBrokenLinks,
  stripBrokenLinkStamps,
  validateWikiInternalLinks,
} from "../src/agent/wiki-link-validator.ts";

async function setupWiki(outputMode: "local-wiki" | "repository" = "repository") {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-links-"));
  const backend = new OpenWikiLocalShellBackend({
    docsOnly: true,
    outputMode,
    rootDir,
    virtualMode: true,
  });
  return { backend, rootDir };
}

describe("validateWikiInternalLinks", () => {
  test("accepts valid relative file links without rewriting", async () => {
    const { backend, rootDir } = await setupWiki();
    await backend.write(
      "/openwiki/quickstart.md",
      "# Quickstart\n\nSee [architecture](./architecture/overview.md).\n",
    );
    await backend.write("/openwiki/architecture/overview.md", "# Overview\n");
    const before = await readFile(
      path.join(rootDir, "openwiki/quickstart.md"),
      "utf8",
    );
    const edit = vi.spyOn(backend, "edit");

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report).toMatchObject({
      filesScanned: 2,
      issuesFound: 0,
      stampedFiles: [],
    });
    expect(edit).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(rootDir, "openwiki/quickstart.md"), "utf8"),
    ).resolves.toBe(before);
  });

  test("accepts root-relative links from the wiki root", async () => {
    const { backend } = await setupWiki();
    await backend.write(
      "/openwiki/integrations/connectors.md",
      "See [CLI usage](/cli/usage.md).\n",
    );
    await backend.write("/openwiki/cli/usage.md", "# CLI usage\n");

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(0);
    expect(report.stampedFiles).toEqual([]);
  });

  test("stamps missing target files without throwing", async () => {
    const { backend, rootDir } = await setupWiki();
    await backend.write(
      "/openwiki/quickstart.md",
      "Broken [link](./missing.md).\n",
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(1);
    expect(report.stampedFiles).toEqual(["quickstart.md"]);

    const after = await readFile(
      path.join(rootDir, "openwiki/quickstart.md"),
      "utf8",
    );
    expect(after).toContain("openwiki: broken internal link [./missing.md]");
    expect(after).toContain("Broken [link](./missing.md).");
  });

  test("stamps missing heading anchors using GitHub slug rules", async () => {
    const { backend, rootDir } = await setupWiki();
    await backend.write(
      "/openwiki/quickstart.md",
      "See [section](./architecture/overview.md#missing-anchor).\n",
    );
    await backend.write(
      "/openwiki/architecture/overview.md",
      "# Architecture Overview\n\n## a + b\n",
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(1);
    expect(report.stampedFiles).toEqual(["quickstart.md"]);
    const after = await readFile(
      path.join(rootDir, "openwiki/quickstart.md"),
      "utf8",
    );
    expect(after).toContain(
      "openwiki: broken internal link [./architecture/overview.md#missing-anchor]",
    );
  });

  test("clears stale stamps when links become valid", async () => {
    const { backend, rootDir } = await setupWiki();
    const stamp = formatBrokenLinkStamp(
      "./overview.md",
      'file "./overview.md" does not exist',
    );
    await backend.write(
      "/openwiki/quickstart.md",
      `${stamp}\nSee [overview](./overview.md).\n`,
    );
    await backend.write("/openwiki/overview.md", "# Overview\n");

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(0);
    expect(report.stampedFiles).toEqual(["quickstart.md"]);
    await expect(
      readFile(path.join(rootDir, "openwiki/quickstart.md"), "utf8"),
    ).resolves.toBe("See [overview](./overview.md).\n");
  });

  test("accepts duplicate heading anchors with numeric suffixes", async () => {
    const { backend } = await setupWiki();
    await backend.write(
      "/openwiki/quickstart.md",
      [
        "# Hello",
        "",
        "# Hello",
        "",
        "Jump to [first](#hello) or [second](#hello-1).",
        "Cross-page [third](./other.md#hello-1).",
      ].join("\n"),
    );
    await backend.write(
      "/openwiki/other.md",
      "# Hello\n\n# Hello\n\n## Details\n",
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(0);
  });

  test("accepts directory links", async () => {
    const { backend, rootDir } = await setupWiki();
    await mkdir(path.join(rootDir, "openwiki", "agent"), { recursive: true });
    await writeFile(
      path.join(rootDir, "openwiki", "page.md"),
      "- [agent](agent/)\n",
      "utf8",
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(0);
  });

  test("ignores external links and images", async () => {
    const { backend } = await setupWiki();
    await backend.write(
      "/openwiki/quickstart.md",
      [
        "External [site](https://example.com).",
        "Image ![logo](./missing.png).",
      ].join("\n"),
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(0);
  });

  test("skips reserved files", async () => {
    const { backend, rootDir } = await setupWiki();
    const dir = path.join(rootDir, "openwiki");
    await mkdir(dir, { recursive: true });
    for (const name of ["index.md", "log.md", "_plan.md", "INSTRUCTIONS.md"]) {
      await writeFile(path.join(dir, name), "Broken [link](./missing.md).\n");
    }

    const edit = vi.spyOn(backend, "edit");
    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.filesScanned).toBe(0);
    expect(report.issuesFound).toBe(0);
    expect(edit).not.toHaveBeenCalled();
  });

  test("returns a zero report for a missing wiki root without throwing", async () => {
    const { backend } = await setupWiki();

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report).toEqual({
      filesScanned: 0,
      linksChecked: 0,
      issuesFound: 0,
      stampedFiles: [],
    });
  });
});

describe("broken link stamp helpers", () => {
  test("formats actionable validation diagnostics", () => {
    const message = formatWikiLinkIssues([
      {
        href: "./missing.md",
        line: 4,
        message: 'file "./missing.md" does not exist',
        sourcePath: "/openwiki/quickstart.md",
      },
    ]);

    expect(message).toContain("OpenWiki internal link validation found broken links");
    expect(message).toContain(
      '/openwiki/quickstart.md:4 [./missing.md] file "./missing.md" does not exist',
    );
  });

  test("strips and re-stamps broken link comments idempotently", () => {
    const stamp = formatBrokenLinkStamp(
      "./missing.md",
      'file "./missing.md" does not exist',
    );
    const content = `${stamp}\nBroken [link](./missing.md).\n`;
    const cleaned = stripBrokenLinkStamps(content);
    expect(cleaned).toBe("Broken [link](./missing.md).\n");

    const restamped = stampBrokenLinks(cleaned, [
      {
        href: "./missing.md",
        line: 1,
        message: 'file "./missing.md" does not exist',
        sourcePath: "/openwiki/quickstart.md",
      },
    ]);
    expect(restamped).toBe(content);
  });
});
