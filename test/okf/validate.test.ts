import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { normalizeOkfBundle } from "../../src/agent/okf/normalize.ts";
import { validateBundle } from "../../src/agent/okf/validate.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "okf-validate-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function writeWiki(relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(cwd, "openwiki", relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

function bundleRoot(): string {
  return path.join(cwd, "openwiki");
}

describe("validateBundle", () => {
  test("flags a missing type (error) and a broken link (warning)", async () => {
    await writeWiki(
      "quickstart.md",
      "---\ntype: Overview\ntitle: Q\ndescription: d.\n---\n# Q\n\nSee [x](/domain/missing.md).\n",
    );
    await writeWiki(
      "domain/orphan.md",
      "---\ntitle: No type\ndescription: d.\n---\n# No type\n\nBody.\n",
    );

    const findings = await validateBundle(bundleRoot());

    expect(
      findings.some(
        (f) => f.code === "missing-type" && f.file === "domain/orphan.md",
      ),
    ).toBe(true);
    expect(
      findings.some(
        (f) => f.code === "broken-link" && f.file === "quickstart.md",
      ),
    ).toBe(true);
  });

  test("a normalized bundle has zero errors", async () => {
    await writeWiki(
      "quickstart.md",
      "# Home\n\nThe entry point for the docs.\n",
    );
    await writeWiki(
      "architecture/overview.md",
      "# Overview\n\nHow the pieces fit together.\n",
    );

    await normalizeOkfBundle({
      cwd,
      outputMode: "repository",
      command: "init",
      model: "test-model",
      beforeBodyHashes: new Map(),
      now: new Date("2026-07-10T12:00:00.000Z"),
    });

    const errors = (await validateBundle(bundleRoot())).filter(
      (f) => f.level === "error",
    );
    expect(errors).toEqual([]);
  });
});
