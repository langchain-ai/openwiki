import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  collectMarkdownFiles,
  isReservedFile,
  writeFileAtomic,
} from "../../src/agent/okf/bundle.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "okf-bundle-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  test("writes final content and leaves no temp file behind", async () => {
    const target = path.join(root, "sub", "page.md");
    await writeFileAtomic(target, "hello\n");

    expect(await readFile(target, "utf8")).toBe("hello\n");
    const entries = await readdir(path.join(root, "sub"));
    expect(entries).toEqual(["page.md"]);
    expect(entries.some((name) => name.includes(".okf-tmp"))).toBe(false);
  });
});

describe("collectMarkdownFiles", () => {
  test("returns sorted, recursive, markdown-only relative paths", async () => {
    await mkdir(path.join(root, "architecture"), { recursive: true });
    await writeFile(path.join(root, "quickstart.md"), "");
    await writeFile(path.join(root, "architecture", "overview.md"), "");
    await writeFile(path.join(root, "notes.txt"), "");

    expect(await collectMarkdownFiles(root)).toEqual([
      "architecture/overview.md",
      "quickstart.md",
    ]);
  });

  test("returns empty for a missing root", async () => {
    expect(await collectMarkdownFiles(path.join(root, "nope"))).toEqual([]);
  });
});

describe("isReservedFile", () => {
  test("index.md and log.md are reserved at any depth; concepts are not", () => {
    expect(isReservedFile("index.md")).toBe(true);
    expect(isReservedFile("log.md")).toBe(true);
    expect(isReservedFile("domain/index.md")).toBe(true);
    expect(isReservedFile("quickstart.md")).toBe(false);
    expect(isReservedFile("architecture/overview.md")).toBe(false);
  });
});
