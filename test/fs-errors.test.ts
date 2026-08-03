import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isExpectedSnapshotRaceError,
  isFileNotFoundError,
  pathExists,
} from "../src/fs-errors.ts";

// Spy on the module's stat so pathExists's non-ENOENT error path can be
// simulated; real calls still pass through to the actual implementation.
vi.mock("node:fs/promises", { spy: true });

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("isFileNotFoundError", () => {
  test("is true for an ENOENT error", () => {
    expect(isFileNotFoundError(errnoError("ENOENT"))).toBe(true);
  });

  test("is false for other error codes", () => {
    expect(isFileNotFoundError(errnoError("EACCES"))).toBe(false);
    expect(isFileNotFoundError(errnoError("EISDIR"))).toBe(false);
  });

  test("is false for an Error with no code", () => {
    expect(isFileNotFoundError(new Error("boom"))).toBe(false);
  });

  test("is false for non-error values", () => {
    expect(isFileNotFoundError(null)).toBe(false);
    expect(isFileNotFoundError("ENOENT")).toBe(false);
    expect(isFileNotFoundError({ code: "ENOENT" })).toBe(false);
  });
});

describe("isExpectedSnapshotRaceError", () => {
  test("is true for the tolerated snapshot race codes", () => {
    for (const code of ["EISDIR", "ENOENT", "ENOTDIR"]) {
      expect(isExpectedSnapshotRaceError(errnoError(code))).toBe(true);
    }
  });

  test("is false for unrelated error codes", () => {
    expect(isExpectedSnapshotRaceError(errnoError("EACCES"))).toBe(false);
  });

  test("is false for an Error with no code", () => {
    expect(isExpectedSnapshotRaceError(new Error("boom"))).toBe(false);
  });

  test("is false for non-error values", () => {
    expect(isExpectedSnapshotRaceError(null)).toBe(false);
    expect(isExpectedSnapshotRaceError({ code: "ENOENT" })).toBe(false);
  });
});

describe("pathExists", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "openwiki-fs-errors-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.mocked(stat).mockRestore();
  });

  test("is false for a missing path", async () => {
    expect(await pathExists(join(dir, "missing"))).toBe(false);
  });

  test("is true for an existing file", async () => {
    const filePath = join(dir, "file.txt");
    await writeFile(filePath, "hello");
    expect(await pathExists(filePath)).toBe(true);
  });

  test("is true for an existing directory", async () => {
    const dirPath = join(dir, "subdir");
    await mkdir(dirPath);
    expect(await pathExists(dirPath)).toBe(true);
  });

  test("is true when stat fails with a non-ENOENT error", async () => {
    const errno = Object.assign(new Error("is a directory"), {
      code: "EISDIR",
    });
    vi.mocked(stat).mockRejectedValueOnce(errno);
    expect(await pathExists(join(dir, "anywhere"))).toBe(true);
  });
});
