import { describe, expect, test } from "vitest";
import { findUnexpectedChanges } from "../src/agent/cli-runner/index.ts";

describe("findUnexpectedChanges", () => {
  test("returns nothing for a clean working tree", () => {
    expect(findUnexpectedChanges("", "")).toEqual([]);
    expect(findUnexpectedChanges("", "\n")).toEqual([]);
  });

  test("ignores changes confined to the openwiki/ wiki directory", () => {
    const porcelain = [
      " M openwiki/quickstart.md",
      "?? openwiki/architecture/overview.md",
      "A  openwiki/_plan.md",
    ].join("\n");

    expect(findUnexpectedChanges("", porcelain)).toEqual([]);
  });

  test("flags a source file change outside openwiki/ on a clean baseline", () => {
    const porcelain = [" M openwiki/quickstart.md", " M src/index.ts"].join(
      "\n",
    );

    expect(findUnexpectedChanges("", porcelain)).toEqual(["src/index.ts"]);
  });

  test("does not re-attribute pre-existing dirty-tree changes to the agent", () => {
    // Update runs deliberately proceed on dirty trees: anything already
    // changed before the run must not be blamed on the CLI agent.
    const baseline = [" M src/index.ts", "?? notes.txt"].join("\n");
    const after = [
      " M src/index.ts",
      "?? notes.txt",
      " M openwiki/quickstart.md",
    ].join("\n");

    expect(findUnexpectedChanges(baseline, after)).toEqual([]);
  });

  test("flags only the new out-of-wiki path on a dirty baseline", () => {
    const baseline = " M src/index.ts";
    const after = [" M src/index.ts", " M src/agent/types.ts"].join("\n");

    expect(findUnexpectedChanges(baseline, after)).toEqual([
      "src/agent/types.ts",
    ]);
  });

  test("flags a rename that moves a source file into openwiki/", () => {
    // Porcelain rename form: "R  old -> new". The origin path is a source
    // file, so the move is an out-of-wiki mutation even though the
    // destination lives under openwiki/.
    const porcelain = "R  src/notes.ts -> openwiki/notes.md";

    expect(findUnexpectedChanges("", porcelain)).toEqual(["src/notes.ts"]);
  });

  test("does not flag a rename fully inside openwiki/", () => {
    const porcelain = "R  openwiki/a.md -> openwiki/b.md";

    expect(findUnexpectedChanges("", porcelain)).toEqual([]);
  });

  test("does not split a literal ' -> ' filename on non-rename lines", () => {
    // Git only C-quotes control chars, '"', '\\', and non-ASCII, so a path
    // containing a literal " -> " stays unquoted. Only rename/copy status
    // lines encode two paths.
    const porcelain = "?? src/a -> b.ts";

    expect(findUnexpectedChanges("", porcelain)).toEqual(["src/a -> b.ts"]);
  });

  test("handles C-quoted paths (core.quotePath)", () => {
    const porcelain = [
      '?? "src/weird\\"name.ts"',
      '?? "openwiki/weird\\"name.md"',
    ].join("\n");

    expect(findUnexpectedChanges("", porcelain)).toEqual(['src/weird"name.ts']);
  });

  test("deduplicates repeated out-of-wiki paths", () => {
    const porcelain = [" M src/index.ts", "MM src/index.ts"].join("\n");

    expect(findUnexpectedChanges("", porcelain)).toEqual(["src/index.ts"]);
  });
});
