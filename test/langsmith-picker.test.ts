import { describe, expect, test } from "vitest";
import {
  getLangsmithPickerRows,
  getWindowBounds,
} from "../src/credentials.tsx";

describe("getLangsmithPickerRows", () => {
  test("an empty search shows the current selection", () => {
    expect(getLangsmithPickerRows(["prod", "staging"], "", ["a", "b"])).toEqual(
      [
        { kind: "project", name: "a" },
        { kind: "project", name: "b" },
      ],
    );
  });

  test("an empty search with no selection is empty", () => {
    expect(getLangsmithPickerRows(["prod"], "", [])).toEqual([]);
  });

  test("filters by substring (case-insensitive) and offers a manual add", () => {
    expect(getLangsmithPickerRows(["prod", "staging"], "STAG", [])).toEqual([
      { kind: "manual", name: "STAG" },
      { kind: "project", name: "staging" },
    ]);
  });

  test("omits the manual row when the filter exactly names a project", () => {
    expect(getLangsmithPickerRows(["prod", "staging"], "prod", [])).toEqual([
      { kind: "project", name: "prod" },
    ]);
  });

  test("omits the manual row when the filter is already selected", () => {
    expect(getLangsmithPickerRows([], "prod", ["prod"])).toEqual([]);
  });

  test("offers a manual add when nothing matches (missing project / failed load)", () => {
    expect(getLangsmithPickerRows(["prod"], "new-bot", [])).toEqual([
      { kind: "manual", name: "new-bot" },
    ]);
    expect(getLangsmithPickerRows([], "only-manual", [])).toEqual([
      { kind: "manual", name: "only-manual" },
    ]);
  });

  test("trims the filter for both matching and the manual row", () => {
    expect(getLangsmithPickerRows(["prod"], "  prod  ", [])).toEqual([
      { kind: "project", name: "prod" },
    ]);
  });
});

describe("getWindowBounds", () => {
  test("shows the whole list when it fits", () => {
    expect(getWindowBounds(5, 3, 8)).toEqual({ end: 5, start: 0 });
  });

  test("anchors at the top when the cursor is near the start", () => {
    expect(getWindowBounds(20, 0, 8)).toEqual({ end: 8, start: 0 });
  });

  test("centers the window around the cursor in the middle", () => {
    expect(getWindowBounds(20, 10, 8)).toEqual({ end: 14, start: 6 });
  });

  test("clamps to the end when the cursor is near the bottom", () => {
    expect(getWindowBounds(20, 19, 8)).toEqual({ end: 20, start: 12 });
  });
});
