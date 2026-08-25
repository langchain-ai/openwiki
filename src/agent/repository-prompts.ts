import type { InspectedClaim } from "../claims/brains/code/types.js";
import {
  CLAIMS_RECONCILIATION_GUIDANCE,
  CLAIMS_SUBSTANCE_GUIDANCE,
} from "../claims/guidance.js";
import type { ActiveBeginView } from "../generation/repository-run.js";
import type { PageJob } from "../generation/run-state.js";

/**
 * Builds the bounded planner prompt from the complete active run context.
 *
 * @param view - Durable begin/resume context projected for planning.
 * @param planningContext - Actual user and connector context for this run.
 * @returns Complete planner system prompt.
 */
export function createRepositoryPlannerPrompt(
  view: ActiveBeginView,
  planningContext?: string,
): string {
  const updateContext =
    view.mode === "update"
      ? `\nChanged repository paths:\n${formatList(view.changedPaths)}\n\nClaims requiring attention:\n${formatIssues(view.claimIssues)}`
      : "";

  const semanticContext = planningContext
    ? `\nUser and connector planning context:\n${planningContext}\n`
    : "";

  return `You are planning an OpenWiki code wiki for this repository.

Your only output action is submit_plan. Do not write documentation and do not
delegate work.

Design the smallest complete repository-specific information architecture that
helps a coding agent understand and safely change the system. Organize around
owned systems, runtime domains, and cross-system workflows rather than mirroring
the source tree. Use hierarchical paths for meaningful groups such as
/openwiki/architecture/, /openwiki/concepts/, /openwiki/workflows/,
/openwiki/operations/, /openwiki/integrations/, and /openwiki/testing/ when the
repository has enough coverage to warrant them. Do not emit a flat dump of
unrelated top-level pages. Include /openwiki/quickstart.md for init.

Explore before submitting the plan. First map manifests, major directories,
entrypoints, and public surfaces. Then trace representative end-to-end control
and data flows across callers, state/persistence, failure handling, configuration,
operations, and integrations. Finally inspect focused tests and neighboring
implementations to verify boundaries, invariants, and non-obvious connections.
Do not stop at directory names or one representative file. Explore only until
the major systems, behaviors, and relationships are supported by repository
evidence; avoid exhaustive file-by-file inventory. Page paths are final once
submitted.

Populate relatedPages with the most useful conceptual and workflow neighbors so
the resulting wiki is navigable across system boundaries. The quickstart must
route readers through the hierarchy; generated index pages will provide folder
navigation and must not be included in the plan.

Init MUST include /openwiki/quickstart.md. Update MUST NOT delete quickstart. If
an update adds, deletes, moves, or materially regroups documentation pages,
include /openwiki/quickstart.md in the plan so its task-routing map is refreshed.
An update with no required page edits and no deletions may submit pages: [].

For every page provide a concise purpose and useful seedPaths. seedPaths are
starting points, not research boundaries. Copy only relevant global constraints
from the user/connector context into that page's instructions array; do not copy
unrelated context into every job.${semanticContext}${updateContext}

${view.wikiGoal ? `Repository OpenWiki instructions:\n${view.wikiGoal}\n` : ""}`;
}

/**
 * Complete page-worker context returned by the durable queue.
 */
export type RepositoryPageWorkerJob = PageJob & {
  /**
   * Repository generation command that owns this job.
   */
  mode: "init" | "update";

  /**
   * Whether the assigned Markdown page already exists.
   */
  existing: boolean;

  /**
   * Complete persisted Claim set currently owned by the assigned page.
   */
  existingClaims: InspectedClaim[];
};

/**
 * Builds the prompt for one fresh worker owning exactly one page job.
 *
 * @param job - Assigned page and its complete existing Claim context.
 * @param allPages - Complete ordered page queue for quickstart navigation.
 * @param language - Resolved output language for generated prose.
 * @returns Complete page-worker system prompt.
 */
export function createRepositoryPagePrompt(
  job: RepositoryPageWorkerJob,
  allPages: readonly PageJob[],
  language: string,
): string {
  return `You own exactly ${job.path}.

Title: ${job.title}
Purpose: ${job.purpose}
Mode: ${job.mode}
Existing page: ${job.existing ? "yes" : "no"}
Output language: ${language}
Seed source paths:\n${formatList(job.seedPaths)}
Related pages:\n${formatList(job.relatedPages)}
Page-specific global instructions:\n${formatList(job.instructions)}

${job.mode === "update" ? "Read the current page first. Preserve accurate unaffected content; change only what current repository evidence requires.\n" : ""}
Write wiki prose and human-readable frontmatter values in ${language}. Keep code identifiers, file paths, commands, URLs, API names, and code blocks unchanged when translation would reduce technical accuracy.

The page MUST begin with valid OKF concept frontmatter:
---
type: <short descriptive concept type>
title: <human-readable page title>
description: <one or two sentence retrieval-oriented summary>
tags: [<stable English tag>, ...]
---
Do not author generated, verified, sources, timestamp, or OpenWiki control fields; OpenWiki owns those. On update preserve unknown producer-defined frontmatter fields unless they are factually wrong.

Research deeply enough to explain the important responsibilities, entrypoints,
mechanisms/control flow, relationships, state/lifecycle, invariants/failures,
extension points, configuration/operations, and focused tests that actually
matter for this topic. Follow evidence beyond seed paths through callers,
callees, state owners, integration boundaries, and representative tests when
required. Do not turn the page into a source-file inventory.

Write only ${job.path}. Do not create, edit, or delete another wiki page. After
writing it, call submit_page with the COMPLETE intended material Claim set for
this page. Reuse an existing Claim id when retaining or revising a known
proposition. Omit the id for a genuinely new Claim. Omitting an old Claim
retracts it. Every evidence resource MUST be a canonical repository URI such as
repo://src/agent/index.ts or repo://src/agent/index.ts#L40-L82; a bare path such
as src/agent/index.ts is invalid. If submission validation fails, read the tool
error, correct the page or Claim payload, and retry; the worker completes after
one successful submission.

${CLAIMS_SUBSTANCE_GUIDANCE}

${CLAIMS_RECONCILIATION_GUIDANCE}

Existing Claims:\n${JSON.stringify(job.existingClaims, null, 2)}

${
  job.path === "/openwiki/quickstart.md"
    ? `The complete planned page map is:\n${JSON.stringify(
        allPages.map(({ path, title, purpose }) => ({ path, title, purpose })),
        null,
        2,
      )}\nUse it to produce a compact task-routing map and link to the major domains.`
    : ""
}`;
}

/**
 * Formats an ordered string collection for inclusion in a model prompt.
 *
 * @param values - Ordered values to render.
 * @returns Markdown list with an explicit empty marker.
 */
function formatList(values: readonly string[]): string {
  return values.length > 0
    ? values.map((value) => `- ${value}`).join("\n")
    : "- (none)";
}

/**
 * Formats stable Claims preflight issues for repository planning context.
 *
 * @param issues - Complete deterministic Claims preflight issues.
 * @returns Markdown list with an explicit empty marker.
 */
function formatIssues(issues: ActiveBeginView["claimIssues"]): string {
  return issues.length > 0
    ? issues
        .map(
          (issue) =>
            `- ${issue.page}: ${issue.claimId} (${issue.kind}) -> ${issue.resources.join(", ")}`,
        )
        .join("\n")
    : "- (none)";
}
