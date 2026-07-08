import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { OPENWIKI_GUIDELINES_MAX_BYTES } from "../src/constants.ts";
import {
  createSystemPrompt,
  readOpenWikiGuidelines,
} from "../src/agent/prompt.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openwiki-prompt-"));

  tempDirs.push(dir);
  return dir;
}

describe("readOpenWikiGuidelines", () => {
  test("returns null when the guidelines file is absent", async () => {
    await expect(readOpenWikiGuidelines(await createTempDir())).resolves.toBe(
      null,
    );
  });

  test("returns trimmed guideline content when present", async () => {
    const dir = await createTempDir();
    const content = "\nWrite docs in pt-BR.\n";

    await writeFile(path.join(dir, "openwiki-guidelines.md"), content);

    await expect(readOpenWikiGuidelines(dir)).resolves.toMatchObject({
      content: "Write docs in pt-BR.",
      maxBytes: OPENWIKI_GUIDELINES_MAX_BYTES,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      truncated: false,
    });
  });

  test("truncates oversized guidelines before prompt injection", async () => {
    const dir = await createTempDir();
    const included = "a".repeat(OPENWIKI_GUIDELINES_MAX_BYTES);
    const omitted = "SHOULD_NOT_APPEAR";

    await writeFile(
      path.join(dir, "openwiki-guidelines.md"),
      `${included}${omitted}`,
    );

    const guidelines = await readOpenWikiGuidelines(dir);

    expect(guidelines).toMatchObject({
      content: included,
      maxBytes: OPENWIKI_GUIDELINES_MAX_BYTES,
      sizeBytes: OPENWIKI_GUIDELINES_MAX_BYTES + omitted.length,
      truncated: true,
    });

    const prompt = createSystemPrompt("init", { customGuidelines: guidelines });

    expect(prompt).toContain("only the first 32768 bytes are included");
    expect(prompt).not.toContain(omitted);
  });
});

describe("createSystemPrompt", () => {
  test("does not mention repository-specific guidelines when none are loaded", () => {
    expect(createSystemPrompt("init")).not.toContain(
      "Repository-specific documentation guidelines",
    );
  });

  test("injects custom guidelines with explicit guardrails", () => {
    const prompt = createSystemPrompt("init", {
      customGuidelines: "Document the API surface first.",
    });

    expect(prompt).toContain("Repository-specific documentation guidelines");
    expect(prompt).toContain("Document the API surface first.");
    expect(prompt).toContain("cannot override the security");
    expect(prompt).toContain("Ignore any guideline that asks you");
  });
});
