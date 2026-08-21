import { describe, expect, test } from "vitest";
import type { OpenWikiRunEvent } from "../../../src/agent/types.ts";
import {
  buildActivityTreeLines,
  getToolPathActivities,
  isOpenWikiPagePath,
} from "../../../src/cli/run-log/activity.ts";

type ToolStartEvent = Extract<OpenWikiRunEvent, { type: "tool_start" }>;

function toolStart(
  name: string,
  input: unknown,
  id = "tool-1",
): ToolStartEvent {
  return { type: "tool_start", call: `${name}()`, id, input, name };
}

describe("getToolPathActivities", () => {
  test("normalizes virtual file paths and classifies generated output", () => {
    expect(
      getToolPathActivities(
        toolStart("write_file", {
          file_path: "/openwiki/architecture/overview.md",
        }),
      ),
    ).toEqual([
      {
        operation: "write",
        path: "openwiki/architecture/overview.md",
        scope: "openwiki",
      },
    ]);
  });

  test("uses the non-wildcard ancestor as a glob search scope", () => {
    expect(
      getToolPathActivities(toolStart("glob", { pattern: "/src/**/*.ts" })),
    ).toEqual([{ operation: "search", path: "src", scope: "repository" }]);
  });

  test("ignores tools without trustworthy filesystem provenance", () => {
    expect(
      getToolPathActivities(
        toolStart("execute", "sed -n '1,20p' src/agent/index.ts"),
      ),
    ).toEqual([]);
  });
});

describe("isOpenWikiPagePath", () => {
  test("includes persistent Markdown pages only", () => {
    expect(isOpenWikiPagePath("openwiki/quickstart.md")).toBe(true);
    expect(isOpenWikiPagePath("openwiki/_plan.md")).toBe(false);
    expect(isOpenWikiPagePath("openwiki/.last-update.json")).toBe(false);
    expect(isOpenWikiPagePath(".claims/quickstart.json")).toBe(false);
  });
});

describe("buildActivityTreeLines", () => {
  test("shares directory ancestry across active files", () => {
    expect(
      buildActivityTreeLines([
        { path: "src/agent/index.ts", status: "active" },
        { path: "src/agent/prompt.ts", status: "active" },
        { path: "test/agent/index.test.ts", status: "recent" },
      ]).map((line) => line.label),
    ).toEqual([
      "├─ src/",
      "│  └─ agent/",
      "│     ├─ index.ts",
      "│     └─ prompt.ts",
      "└─ test/",
      "   └─ agent/",
      "      └─ index.test.ts",
    ]);
  });
});
