import { cpSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { OpenWikiLocalShellBackend } from "../../src/agent/docs-only-backend.ts";
import { validateWikiInternalLinks } from "../../src/agent/wiki-link-validator.ts";

describe("validateWikiInternalLinks dogfood", () => {
  test("accepts the repository's checked-in openwiki tree", async () => {
    // Validated against a copy, not the live checkout: a broken link found in
    // real content is stamped in place by `backend.edit`, and this test's
    // whole point is to run the validator over real, possibly-broken content.
    // Reading straight from the checkout would let a single bad link in
    // someone's working tree get rewritten by `pnpm test`.
    // Two levels up from test/agent/, not one: the previous single ".." landed
    // on test/, which has no openwiki/ dir, so `backend.ls("/openwiki")` always
    // failed and this test silently scanned zero files regardless of content.
    const repoRoot = path.resolve(import.meta.dirname, "..", "..");
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "openwiki-dogfood-"));
    cpSync(path.join(repoRoot, "openwiki"), path.join(tempRoot, "openwiki"), {
      recursive: true,
    });
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      outputMode: "repository",
      rootDir: tempRoot,
      virtualMode: true,
    });

    const report = await validateWikiInternalLinks(backend, "repository");

    expect(report.issuesFound).toBe(0);
    expect(report.stampedFiles).toEqual([]);
  });
});
