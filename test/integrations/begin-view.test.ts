import { describe, expect, test } from "vitest";
import type { ActiveBeginView } from "../../src/generation/repository-run.ts";
import {
  HOST_BEGIN_CLAIM_ISSUE_LIMIT,
  HOST_BEGIN_PATH_LIMIT,
  toHostActiveBeginView,
} from "../../src/integrations/core/begin-view.ts";

/**
 * Builds an active begin view with the given list contents.
 *
 * @param overrides - Fields that differ from an empty update view.
 * @returns Complete view for projection tests.
 */
function activeView(overrides: Partial<ActiveBeginView>): ActiveBeginView {
  return {
    status: "active",
    runId: "run",
    root: "/repo",
    mode: "update",
    language: "en",
    languageChanged: false,
    phase: "planning",
    resumed: false,
    lastUpdate: null,
    changedPaths: [],
    pageUpdateWindows: [],
    claimIssues: [],
    completedPages: 0,
    ...overrides,
  };
}

/**
 * Builds distinct repository paths.
 *
 * @param count - Number of paths.
 * @returns Paths in generation order.
 */
function paths(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `src/file-${index}.ts`);
}

/**
 * Builds Claims issues spread evenly across pages.
 *
 * @param count - Number of issues.
 * @param pageCount - Number of distinct pages.
 * @returns Stale issues in generation order.
 */
function claimIssues(
  count: number,
  pageCount: number,
): ActiveBeginView["claimIssues"] {
  return Array.from({ length: count }, (_, index) => ({
    page: `/openwiki/page-${index % pageCount}.md`,
    kind: "stale" as const,
    claimId: `claim_${index}`,
    resources: [`repo://src/file-${index}.ts#L1-L2`],
  }));
}

describe("toHostActiveBeginView", () => {
  test("caps Claims issues and still names every affected page", () => {
    const pageCount = HOST_BEGIN_CLAIM_ISSUE_LIMIT + 10;
    const issues = claimIssues(HOST_BEGIN_CLAIM_ISSUE_LIMIT + 100, pageCount);

    const view = toHostActiveBeginView(activeView({ claimIssues: issues }));

    expect(view.claimIssues).toEqual(
      issues.slice(0, HOST_BEGIN_CLAIM_ISSUE_LIMIT),
    );
    expect(view.claimIssueCount).toBe(issues.length);
    expect(view.claimIssuesTruncated).toBe(true);
    expect(view.claimIssuePages).toHaveLength(pageCount);
    expect(view.claimIssuePages).toContain(
      `/openwiki/page-${pageCount - 1}.md`,
    );
  });

  test("splits the path limit across update windows", () => {
    const windowCount = 8;
    const window = {
      baseGitHead: "abc",
      pages: ["/openwiki/quickstart.md"],
      changedPaths: paths(HOST_BEGIN_PATH_LIMIT),
      fullReview: false,
    };

    const view = toHostActiveBeginView(
      activeView({
        pageUpdateWindows: Array.from({ length: windowCount }, () => window),
      }),
    );

    const returned = view.pageUpdateWindows.flatMap(
      ({ changedPaths }) => changedPaths,
    );
    expect(returned).toHaveLength(HOST_BEGIN_PATH_LIMIT);
    for (const bounded of view.pageUpdateWindows) {
      expect(bounded.changedPathCount).toBe(HOST_BEGIN_PATH_LIMIT);
      expect(bounded.changedPathsTruncated).toBe(true);
    }
  });

  test("leaves lists at the limits complete", () => {
    const issues = claimIssues(HOST_BEGIN_CLAIM_ISSUE_LIMIT, 3);
    const changedPaths = paths(HOST_BEGIN_PATH_LIMIT);

    const view = toHostActiveBeginView(
      activeView({ changedPaths, claimIssues: issues }),
    );

    expect(view.changedPaths).toEqual(changedPaths);
    expect(view.changedPathsTruncated).toBe(false);
    expect(view.claimIssues).toEqual(issues);
    expect(view.claimIssuesTruncated).toBe(false);
    expect(view.claimIssuePages).toEqual([
      "/openwiki/page-0.md",
      "/openwiki/page-1.md",
      "/openwiki/page-2.md",
    ]);
  });
});
