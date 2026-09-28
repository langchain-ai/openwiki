import { describe, expect, test } from "vitest";
import {
  formatRepositoryPrintProgress,
  formatRepositoryProgress,
} from "../../../src/cli/run-log/progress.ts";

describe("formatRepositoryProgress", () => {
  test("keeps the single-worker page position line", () => {
    expect(
      formatRepositoryProgress(
        {
          type: "repository_progress",
          stage: "generating",
          page: "/openwiki/architecture.md",
          pageIndex: 2,
          pageCount: 4,
        },
        "update",
      ),
    ).toBe("Documenting page 2 of 4 · /openwiki/architecture.md");
  });

  test("keeps the page position line while one concurrent worker remains", () => {
    expect(
      formatRepositoryProgress(
        {
          type: "repository_progress",
          stage: "generating",
          page: "/openwiki/architecture.md",
          pageIndex: 2,
          pageCount: 4,
          completedCount: 3,
          inFlightPages: ["/openwiki/architecture.md"],
        },
        "update",
      ),
    ).toBe("Documenting page 2 of 4 · /openwiki/architecture.md");
  });

  test("reports completed count and in-flight pages for concurrent workers", () => {
    const line = formatRepositoryProgress(
      {
        type: "repository_progress",
        stage: "generating",
        page: "/openwiki/b.md",
        pageIndex: 2,
        pageCount: 20,
        completedCount: 5,
        inFlightPages: ["/openwiki/a.md", "/openwiki/b.md", "/openwiki/c.md"],
      },
      "update",
    );

    expect(line).toBe(
      "Documenting 5 of 20 · 3 in flight: /openwiki/a.md, /openwiki/b.md, /openwiki/c.md",
    );
    expect(
      formatRepositoryPrintProgress(
        {
          type: "repository_progress",
          stage: "generating",
          pageCount: 20,
          completedCount: 5,
          inFlightPages: ["/openwiki/a.md", "/openwiki/b.md"],
        },
        "init",
      ),
    ).toBe(
      "Documenting 5 of 20 · 2 in flight: /openwiki/a.md, /openwiki/b.md\n",
    );
  });
});
