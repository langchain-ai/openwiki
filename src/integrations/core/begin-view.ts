import type {
  ActiveBeginView,
  RepositoryPageUpdateWindow,
} from "../../generation/repository-run.js";

/**
 * Most paths returned in the top-level list, and across all update windows.
 */
export const HOST_BEGIN_PATH_LIMIT = 200;

/**
 * Most Claims issues returned to a host.
 */
export const HOST_BEGIN_CLAIM_ISSUE_LIMIT = 50;

/**
 * Update window whose path list is bounded for a host.
 */
export interface HostPageUpdateWindow extends RepositoryPageUpdateWindow {
  /**
   * Exact number of visible paths changed after the shared baseline.
   */
  changedPathCount: number;

  /**
   * Whether `changedPaths` omits paths beyond this window's share of the limit.
   */
  changedPathsTruncated: boolean;
}

/**
 * Active begin view with bounded lists and exact totals.
 */
export interface HostActiveBeginView extends Omit<
  ActiveBeginView,
  "changedPaths" | "pageUpdateWindows"
> {
  /**
   * First changed paths in code-unit order, up to the path limit.
   */
  changedPaths: string[];

  /**
   * Exact number of repository paths changed since the previous run.
   */
  changedPathCount: number;

  /**
   * Whether `changedPaths` omits paths beyond the path limit.
   */
  changedPathsTruncated: boolean;

  /**
   * Existing factual pages grouped by baseline, with bounded path lists.
   */
  pageUpdateWindows: HostPageUpdateWindow[];

  /**
   * Exact number of Claims preflight issues.
   */
  claimIssueCount: number;

  /**
   * Whether `claimIssues` omits issues beyond the issue limit.
   */
  claimIssuesTruncated: boolean;

  /**
   * Every page with a Claims issue, including pages of omitted issues.
   */
  claimIssuePages: string[];
}

/**
 * Bounds the lists of an active begin view for host transports.
 *
 * Totals stay exact. Planning and page jobs read the run's own state, so a host
 * loses no required work: omitted paths come from its own Git, and each page's
 * Claims come back from `openwiki_next_page`.
 *
 * @param view - Full view the in-process planner consumes.
 * @returns Copy whose lists hold at most the host limits.
 */
export function toHostActiveBeginView(
  view: ActiveBeginView,
): HostActiveBeginView {
  const windowPathLimit = Math.max(
    1,
    Math.floor(HOST_BEGIN_PATH_LIMIT / view.pageUpdateWindows.length),
  );
  return {
    ...view,
    changedPaths: view.changedPaths.slice(0, HOST_BEGIN_PATH_LIMIT),
    changedPathCount: view.changedPaths.length,
    changedPathsTruncated: view.changedPaths.length > HOST_BEGIN_PATH_LIMIT,
    pageUpdateWindows: view.pageUpdateWindows.map((window) => ({
      ...window,
      changedPaths: window.changedPaths.slice(0, windowPathLimit),
      changedPathCount: window.changedPaths.length,
      changedPathsTruncated: window.changedPaths.length > windowPathLimit,
    })),
    claimIssues: view.claimIssues.slice(0, HOST_BEGIN_CLAIM_ISSUE_LIMIT),
    claimIssueCount: view.claimIssues.length,
    claimIssuesTruncated:
      view.claimIssues.length > HOST_BEGIN_CLAIM_ISSUE_LIMIT,
    claimIssuePages: [
      ...new Set(view.claimIssues.map(({ page }) => page)),
    ].sort(),
  };
}
