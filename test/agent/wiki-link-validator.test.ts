import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { OpenWikiLocalShellBackend } from "../../src/agent/docs-only-backend.ts";
import {
  formatBrokenLinkStamp,
  formatWikiLinkIssues,
  stampBrokenLinks,
  stripBrokenLinkStamps,
  validateWikiInternalLinks,
} from "../../src/agent/wiki-link-validator.ts";
import { RepositoryWikiPaths } from "../../src/repository-wiki/paths.ts";

async function setupWiki(
  outputMode: "local-wiki" | "repository" = "repository",
) {
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

  test("flags repo-root-absolute links carrying the /openwiki prefix", async () => {
    const { backend, rootDir } = await setupWiki();
    await backend.write(
      "/openwiki/integrations/connectors.md",
      "See [CLI usage](/openwiki/cli/usage.md).\n",
    );
    await backend.write("/openwiki/cli/usage.md", "# CLI usage\n");

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(1);
    expect(report.stampedFiles).toEqual(["integrations/connectors.md"]);
    const after = await readFile(
      path.join(rootDir, "openwiki/integrations/connectors.md"),
      "utf8",
    );
    expect(after).toContain('link "/openwiki/cli/usage.md" is root-absolute');
  });

  test("scans and diagnoses links below the configured repository wiki root", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-links-"));
    const wikiPaths = new RepositoryWikiPaths("docs");
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      outputMode: "repository",
      rootDir,
      virtualMode: true,
      wikiPaths,
    });
    await backend.write(
      "/docs/quickstart.md",
      "See [missing](./missing.md) and [absolute](/docs/guide.md).\n",
    );
    await backend.write("/docs/guide.md", "# Guide\n");

    const report = await validateWikiInternalLinks(
      backend,
      "repository",
      wikiPaths,
    );

    expect(report).toMatchObject({
      filesScanned: 2,
      issuesFound: 2,
      stampedFiles: ["quickstart.md"],
    });
    await expect(
      readFile(path.join(rootDir, "docs/quickstart.md"), "utf8"),
    ).resolves.toContain('link "/docs/guide.md" is root-absolute');
    await expect(
      readFile(path.join(rootDir, "openwiki/quickstart.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("flags repo-root-absolute links with heading anchors", async () => {
    const { backend } = await setupWiki();
    await backend.write(
      "/openwiki/architecture/agents.md",
      "See [Shared Browser Tooling](/openwiki/architecture/shared-tools.md#one-browser-tab-per-run).\n",
    );
    await backend.write(
      "/openwiki/architecture/shared-tools.md",
      "# Shared tools\n\n## One browser tab per run\n",
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(1);
    expect(report.stampedFiles).toEqual(["architecture/agents.md"]);
  });

  test("accepts root-absolute links in local-wiki mode, where the backend root is the wiki root", async () => {
    const { backend } = await setupWiki("local-wiki");
    await backend.write(
      "/integrations/connectors.md",
      "See [CLI usage](/cli/usage.md).\n",
    );
    await backend.write("/cli/usage.md", "# CLI usage\n");

    const report = await validateWikiInternalLinks(backend, "local-wiki");

    expect(report.issuesFound).toBe(0);
    expect(report.stampedFiles).toEqual([]);
  });

  test("stamps repo-root-absolute links to missing files", async () => {
    const { backend } = await setupWiki();
    await backend.write(
      "/openwiki/quickstart.md",
      "See [gone](/openwiki/does-not-exist.md).\n",
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(1);
    expect(report.stampedFiles).toEqual(["quickstart.md"]);
  });

  test("stamps repo-root-absolute links with missing anchors", async () => {
    const { backend } = await setupWiki();
    await backend.write(
      "/openwiki/quickstart.md",
      "See [section](/openwiki/overview.md#missing-anchor).\n",
    );
    await backend.write("/openwiki/overview.md", "# Overview\n");

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(1);
    expect(report.stampedFiles).toEqual(["quickstart.md"]);
  });

  test("accepts relative links to existing repo files outside the wiki dir", async () => {
    const { backend, rootDir } = await setupWiki();
    await mkdir(path.join(rootDir, "docs"), { recursive: true });
    await writeFile(
      path.join(rootDir, "docs/decision.md"),
      "# Decision\n",
      "utf8",
    );
    await backend.write(
      "/openwiki/architecture/ui-components.md",
      "See [decision](../../docs/decision.md) and [src](../../src/index.ts).\n",
    );
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(path.join(rootDir, "src/index.ts"), "export {};\n", "utf8");

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(0);
    expect(report.stampedFiles).toEqual([]);
  });

  test("flags repo-root-absolute links outside the wiki dir instead of checking existence", async () => {
    const { backend, rootDir } = await setupWiki();
    await backend.write(
      "/openwiki/architecture/ui-components.md",
      "See [decision](/docs/missing-decision.md).\n",
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(1);
    expect(report.stampedFiles).toEqual(["architecture/ui-components.md"]);
    const after = await readFile(
      path.join(rootDir, "openwiki/architecture/ui-components.md"),
      "utf8",
    );
    expect(after).toContain(
      'link "/docs/missing-decision.md" is root-absolute',
    );
  });

  test("does not validate anchors on non-markdown targets", async () => {
    const { backend, rootDir } = await setupWiki();
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(path.join(rootDir, "src/index.ts"), "export {};\n", "utf8");
    // GitHub line anchors (#L10) on source files must not be treated as broken.
    await backend.write(
      "/openwiki/quickstart.md",
      "See [line](../src/index.ts#L10).\n",
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(0);
    expect(report.stampedFiles).toEqual([]);
  });

  test("accepts GitHub line anchors on markdown targets but still validates heading anchors", async () => {
    const { backend, rootDir } = await setupWiki();
    await mkdir(path.join(rootDir, "docs"), { recursive: true });
    await writeFile(
      path.join(rootDir, "docs/GUIDE.md"),
      "# Guide\n\n## Setup\n\nRun it.\n",
      "utf8",
    );
    await backend.write(
      "/openwiki/quickstart.md",
      [
        "See [range](../docs/GUIDE.md#L3-L5).",
        "See [single](../docs/GUIDE.md#L3).",
        "See [setup](../docs/GUIDE.md#setup).",
        "See [bad](../docs/GUIDE.md#nope).",
        "",
      ].join("\n"),
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(1);
    const after = await readFile(
      path.join(rootDir, "openwiki/quickstart.md"),
      "utf8",
    );
    expect(after).toContain('heading anchor "nope" does not exist');
    expect(after).not.toContain("#L3-L5) <!--");
    expect(after).not.toContain('heading anchor "L3');
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

  test("accepts double-hyphen anchors from stripped punctuation between words", async () => {
    const { backend } = await setupWiki();
    await backend.write(
      "/openwiki/architecture/agents.md",
      [
        "See [tokens](./overview.md#layout-primitives--design-tokens).",
        "See [store](./overview.md#state--store).",
        "See [ab](./overview.md#a--b).",
      ].join("\n"),
    );
    await backend.write(
      "/openwiki/architecture/overview.md",
      "# Overview\n\n## Layout Primitives & Design Tokens\n\n## State / Store\n\n## A + B\n",
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(0);
    expect(report.stampedFiles).toEqual([]);
  });

  test("keeps inline code text in heading anchors", async () => {
    const { backend } = await setupWiki();
    await backend.write(
      "/openwiki/quickstart.md",
      "See [foo](./overview.md#use-foo).\n",
    );
    await backend.write(
      "/openwiki/overview.md",
      "# Overview\n\n## Use `foo`\n",
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(0);
    expect(report.stampedFiles).toEqual([]);
  });

  test("accepts anchors on non-ASCII (unicode) headings", async () => {
    const { backend } = await setupWiki();
    await backend.write(
      "/openwiki/quickstart.md",
      "See [es](./overview.md#configuración) and [ja](./overview.md#概要).\n",
    );
    await backend.write(
      "/openwiki/overview.md",
      "# Overview\n\n## Configuración\n\n## 概要\n",
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(0);
    expect(report.stampedFiles).toEqual([]);
  });

  test("keeps combining marks so decomposed-accent anchors resolve", async () => {
    const { backend } = await setupWiki();
    const combining = "́"; // combining acute accent (decomposed/NFD)
    const heading = `Cre${combining}dit Notes`;
    const anchor = `cre${combining}dit-notes`;
    expect(anchor.includes("́")).toBe(true); // guard: really decomposed
    await backend.write(
      "/openwiki/quickstart.md",
      `See [notes](./overview.md#${anchor}).\n`,
    );
    await backend.write(
      "/openwiki/overview.md",
      `# Overview\n\n## ${heading}\n`,
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(0);
    expect(report.stampedFiles).toEqual([]);
  });

  test("stamps an anchor with a malformed percent escape instead of throwing", async () => {
    const { backend, rootDir } = await setupWiki();
    await backend.write(
      "/openwiki/testing.md",
      "# Testing\n\n## 100% coverage\n\nSee [coverage](#100%-coverage).\n",
    );

    await expect(
      validateWikiInternalLinks(backend, "repository"),
    ).resolves.toMatchObject({
      issuesFound: 1,
      stampedFiles: ["testing.md"],
    });
    const after = await readFile(
      path.join(rootDir, "openwiki/testing.md"),
      "utf8",
    );
    expect(after).toContain(
      'heading anchor "100%-coverage" does not exist in /openwiki/testing.md',
    );
  });

  test("stamps a malformed percent escape in an anchor on another page", async () => {
    const { backend, rootDir } = await setupWiki();
    await backend.write(
      "/openwiki/quickstart.md",
      "See [coverage](./testing.md#100%-coverage).\n",
    );
    await backend.write(
      "/openwiki/testing.md",
      "# Testing\n\n## 100% coverage\n",
    );

    await expect(
      validateWikiInternalLinks(backend, "repository"),
    ).resolves.toMatchObject({
      issuesFound: 1,
      stampedFiles: ["quickstart.md"],
    });
    const after = await readFile(
      path.join(rootDir, "openwiki/quickstart.md"),
      "utf8",
    );
    expect(after).toContain(
      'heading anchor "100%-coverage" does not exist in "./testing.md"',
    );
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

  test("clamps ../-escaping links to the repo root, never the host filesystem", async () => {
    const { backend, rootDir } = await setupWiki();
    // The host has a real /etc/passwd. A link with enough `..` to try to reach
    // it must resolve under the repo root instead: `path.posix.normalize`
    // clamps the leading `..` at `/`, and the backend maps `/etc/passwd` to
    // <repoRoot>/etc/passwd — which does not exist here.
    await backend.write(
      "/openwiki/page.md",
      "See [x](../../../../etc/passwd).\n",
    );
    const readRaw = vi.spyOn(backend, "readRaw");

    const report = await validateWikiInternalLinks(backend, "repository");

    // Reported missing even though the *host* /etc/passwd exists, proving the
    // read was contained to the repo root and never touched the host FS.
    expect(report.issuesFound).toBe(1);
    // No read target ever climbs out of the virtual root via a `..` segment.
    expect(
      readRaw.mock.calls.every(
        ([targetPath]) =>
          typeof targetPath === "string" &&
          targetPath.startsWith("/") &&
          !targetPath.includes("/.."),
      ),
    ).toBe(true);

    const after = await readFile(
      path.join(rootDir, "openwiki/page.md"),
      "utf8",
    );
    expect(after).toContain("openwiki: broken internal link");
    expect(after).toContain('file "../../../../etc/passwd" does not exist');
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

  test("ignores link syntax inside fenced code blocks and inline code", async () => {
    const { backend, rootDir } = await setupWiki();
    const content = [
      "# Events",
      "",
      "```ts",
      "const result = handlers[event.type](event);",
      "```",
      "",
      "~~~~md",
      "See [the guide](./missing-guide.md).",
      "```",
      "~~~~",
      "",
      "Dispatch with `handlers[name](payload)` or ``cb[`key`](arg)``.",
      "",
    ].join("\n");
    await backend.write("/openwiki/events.md", content);
    const edit = vi.spyOn(backend, "edit");

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report).toMatchObject({ issuesFound: 0, stampedFiles: [] });
    expect(edit).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(rootDir, "openwiki/events.md"), "utf8"),
    ).resolves.toBe(content);
  });

  test("still validates links outside code on lines that also contain code", async () => {
    const { backend } = await setupWiki();
    await backend.write(
      "/openwiki/events.md",
      [
        "```sh",
        "echo done",
        "```",
        "",
        "Run `make`, then read [setup](./missing-setup.md).",
      ].join("\n"),
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(1);
    expect(report.stampedFiles).toEqual(["events.md"]);
  });

  test("does not treat comments inside code blocks as heading anchors", async () => {
    const { backend } = await setupWiki();
    await backend.write(
      "/openwiki/setup.md",
      [
        "# Setup",
        "",
        "```sh",
        "# install dependencies",
        "pnpm install",
        "```",
        "",
        "Jump to [install](#install-dependencies).",
      ].join("\n"),
    );

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(1);
  });

  test("skips reserved files", async () => {
    const { backend, rootDir } = await setupWiki();
    const dir = path.join(rootDir, "openwiki");
    await mkdir(dir, { recursive: true });
    for (const name of ["index.md", "log.md", "INSTRUCTIONS.md"]) {
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

    expect(message).toContain(
      "OpenWiki internal link validation found broken links",
    );
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
