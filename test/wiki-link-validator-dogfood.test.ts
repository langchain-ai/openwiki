import path from "node:path";
import { describe, expect, test } from "vitest";
import { OpenWikiLocalShellBackend } from "../src/agent/docs-only-backend.ts";
import { validateWikiInternalLinks } from "../src/agent/wiki-link-validator.ts";

describe("validateWikiInternalLinks dogfood", () => {
  test("accepts the repository's checked-in openwiki tree", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      outputMode: "repository",
      rootDir: repoRoot,
      virtualMode: true,
    });

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(0);
    expect(report.stampedFiles).toEqual([]);
  });
});
