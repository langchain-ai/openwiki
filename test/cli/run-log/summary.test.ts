import { describe, expect, test } from "vitest";
import {
  formatCompletedRunCounts,
  formatRunCompletionTitle,
} from "../../../src/cli/run-log/summary.ts";
import type { RunLogItem } from "../../../src/cli/run-log/types.ts";

describe("formatRunCompletionTitle", () => {
  test("formats minute-scale init outcomes from unique written pages", () => {
    const log: RunLogItem[] = [
      {
        content: "3 writes",
        id: 1,
        status: "done",
        type: "tool",
        writtenPaths: ["openwiki/quickstart.md", "openwiki/cli/usage.md"],
      },
    ];

    expect(formatRunCompletionTitle("init", log, 62_000)).toBe(
      "Generated 2 OpenWiki pages in 1m 2s",
    );
  });

  test("describes a successful no-write update as up to date", () => {
    expect(formatRunCompletionTitle("update", [], 3_000)).toBe(
      "OpenWiki is up to date in 3s",
    );
  });
});

describe("formatCompletedRunCounts", () => {
  test("omits raw write calls after completion", () => {
    expect(
      formatCompletedRunCounts({
        actionCount: 8,
        content: "2 reads · 1 search · 5 writes",
        id: 1,
        readCount: 2,
        searchCount: 1,
        status: "done",
        type: "tool",
        writeCount: 5,
      }),
    ).toBe("2 reads · 1 search");
  });
});
