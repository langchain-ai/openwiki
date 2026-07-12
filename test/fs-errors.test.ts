import { describe, expect, test } from "vitest";
import {
  isExpectedSnapshotRaceError,
  isFileNotFoundError,
} from "../src/fs-errors.ts";

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
