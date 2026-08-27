import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { runOpenWikiAgent } from "../agent/index.js";
import { loadOpenWikiEnv } from "../config/env.js";
import { syncBundledSkills } from "../agent/skills.js";
import { ensureCodeModeRepoSetup } from "../ingestion/code-mode.js";
import type {
  OpenWikiCommand,
  OpenWikiRunOptions,
  OpenWikiRunResult,
} from "../agent/types.js";
import type { RunTelemetryContext } from "../telemetry/index.js";
import {
  getWorkspaceSkipReason,
  readWorkspacesState,
  resolveWorkspaceRuns,
  writeWorkspacesState,
  type ResolvedWorkspacePlan,
  type WorkspaceManifest,
  type WorkspacesState,
} from "./workspaces.js";
import { writeGeneratedFile } from "../safe-write.js";

const execFileAsync = promisify(execFile);

/**
 * Result of a full recursive run: one entry per subproject that actually ran
 * (or was skipped as a no-op), the root run result, the paths skipped because
 * they had no documentable evidence, and the paths whose run threw.
 */
export interface RecursiveRunResult {
  subprojectResults: OpenWikiRunResult[];
  rootResult: OpenWikiRunResult;
  skippedWorkspaces: { path: string; reason: string }[];
  failedWorkspaces: { path: string; error: string }[];
}

/**
 * Runs OpenWiki recursively across a monorepo: one run per subproject (rooted at
 * that subproject, subproject prompt role), then the generated aggregation page,
 * then the root run last (so the root's index-sync middleware picks up
 * openwiki/workspaces.md).
 *
 * Each run goes through the standard {@link runOpenWikiAgent} entry with
 * `outputMode: "repository"` and a per-run `recursionRole`/`wikiGoalOverride`.
 * Because the page-job lifecycle roots the filesystem backend at the run's own
 * directory, a SUBPROJECT run is physically isolated to its own subtree — it
 * cannot read or write siblings or the repository root. Model construction is
 * cheap (no network) and ChatGPT token refresh is cached, so resolving per run
 * is equivalent to the previous "resolve once" path without duplicating the
 * env/telemetry orchestration that runOpenWikiAgent already owns.
 *
 * Runs are SEQUENTIAL by design: they share one bundled-skills directory, and
 * the root run must observe the completed sub-wikis before it links down to
 * them.
 *
 * A subproject run that throws is RESILIENT: the failure is collected in
 * `failedWorkspaces` and the pass continues, so one broken subproject does not
 * abandon the sub-wikis already generated or block the aggregation + root run
 * for the subprojects that succeeded. The root run still executes; the caller
 * decides how to surface `failedWorkspaces`.
 *
 * Update model: each subproject is evaluated INDEPENDENTLY. Its no-op check runs
 * inside the durable lifecycle (beginRepositoryRun) rooted at that subproject,
 * so a subproject regenerates only when files under its own path changed, and
 * the root run always executes. There is NO dependency cascade: a change to a
 * shared subproject refreshes only that sub-wiki (and the root), not the sibling
 * subprojects that depend on it. Dependency-aware invalidation is intentionally
 * out of scope here; see the "no dependency cascade" note in README.md.
 *
 * The ROOT run is rooted at the repository root and so can physically see the
 * generated nested openwiki/ sub-wikis; it is kept from re-documenting them by
 * the "root" prompt role (link DOWN, do not deep-document subprojects) rather
 * than by hard filesystem/git scoping. See NOTE in the code below.
 *
 * The run set comes from resolveWorkspaceRuns, which applies the manifest's
 * `overrides` map: a path marked `exclude: true` produces NO run here (it is
 * documented nowhere yet stays listed so self-maintaining discovery does not
 * re-surface it), and a run's goal/name come from its override when present.
 *
 * Falls back to a single plain root run (no recursion role) when the manifest
 * resolves to zero workspaces.
 */
export async function runRecursiveOpenWiki(
  command: OpenWikiCommand,
  repoRoot: string,
  options: OpenWikiRunOptions,
  manifest: WorkspaceManifest,
  telemetryContext: RunTelemetryContext = {},
): Promise<RecursiveRunResult> {
  const plan = resolveWorkspaceRuns(repoRoot, manifest);

  // Load env + bundled skills once up front. runOpenWikiAgent repeats both per
  // run (they are idempotent), but ensureCodeModeRepoSetup runs before any agent
  // call, and doing it here keeps the sequential skills-dir writes race-free.
  await loadOpenWikiEnv();
  await syncBundledSkills();
  // Recursive runs scaffold a workflow that reruns with --recursive so scheduled
  // refreshes keep every sub-wiki current. As with the non-recursive path, only
  // `init` creates the workflow; `update` leaves an existing one untouched so
  // operator customizations survive.
  await ensureCodeModeRepoSetup(repoRoot, {
    createWorkflow: command === "init",
    recursive: true,
  });

  if (plan.runs.length === 0) {
    // Empty manifest: fall back to a plain single run (NOT the root role). This
    // is the run the caller's telemetry boundary records.
    const rootResult = await runOpenWikiAgent(
      command,
      repoRoot,
      { ...options, outputMode: "repository", skipRepoSetup: true },
      telemetryContext,
    );
    return {
      subprojectResults: [],
      rootResult,
      skippedWorkspaces: [],
      failedWorkspaces: [],
    };
  }

  const subprojectResults: OpenWikiRunResult[] = [];
  const skippedWorkspaces: { path: string; reason: string }[] = [];
  const failedWorkspaces: { path: string; error: string }[] = [];
  const state: WorkspacesState = await readWorkspacesState(repoRoot);

  for (const run of plan.runs) {
    const skipReason = await getWorkspaceSkipReason(repoRoot, run);
    if (skipReason) {
      emitBoundary(
        options,
        `Skipping workspace ${run.relativePath}: ${skipReason}`,
      );
      skippedWorkspaces.push({ path: run.relativePath, reason: skipReason });
      continue;
    }

    emitBoundary(
      options,
      `OpenWiki subproject: ${run.name ?? run.relativePath}`,
    );

    try {
      const result = await runOpenWikiAgent(command, run.absolutePath, {
        ...options,
        outputMode: "repository",
        recursionRole: "subproject",
        // Each run gets a distinct thread; never reuse the top-level threadId.
        threadId: undefined,
        // Manifest goal wins; beginRepositoryRun falls back to this subproject's
        // own openwiki/INSTRUCTIONS.md when the override is undefined.
        wikiGoalOverride: run.goal,
        // The orchestrator already ran repo setup once at the root; subprojects
        // must not scaffold their own (dead) nested workflow.
        skipRepoSetup: true,
      });
      subprojectResults.push(result);

      // Record the subproject's git HEAD so future runs can reason about which
      // subprojects moved. Best-effort: a missing HEAD does not fail the run.
      state.workspaces[run.relativePath] = {
        gitHead: await readGitHead(run.absolutePath),
        updatedAt: new Date().toISOString(),
      };
      await writeWorkspacesState(repoRoot, state);
    } catch (error) {
      // A broken subproject must not abandon the sub-wikis already generated or
      // block aggregation + the root run for the ones that succeeded. Collect
      // the failure and keep going.
      const message = error instanceof Error ? error.message : String(error);
      emitBoundary(
        options,
        `Subproject ${run.relativePath} failed: ${message}`,
      );
      failedWorkspaces.push({ path: run.relativePath, error: message });
    }
  }

  // Aggregation MUST be written before the root run so the root's index-sync
  // (afterAgent middleware) links openwiki/workspaces.md into openwiki/index.md.
  // Link only subprojects that actually produced a sub-wiki: skipped (no
  // evidence) and failed subprojects have no quickstart to link to.
  const excluded = new Set([
    ...skippedWorkspaces.map((entry) => entry.path),
    ...failedWorkspaces.map((entry) => entry.path),
  ]);
  const documentedPlan: ResolvedWorkspacePlan = {
    ...plan,
    runs: plan.runs.filter((run) => !excluded.has(run.relativePath)),
  };
  await writeRootAggregation(repoRoot, documentedPlan);

  emitBoundary(options, "OpenWiki root wiki");
  // NOTE: unlike the old git-scoped path, the root run is rooted at repoRoot and
  // can physically read the nested sub-wikis. It is kept from re-documenting them
  // by the "root" recursion role guidance (link DOWN, do not deep-document), not
  // by hard scoping. See runRecursiveOpenWiki doc comment.
  const rootResult = await runOpenWikiAgent(
    command,
    repoRoot,
    {
      ...options,
      outputMode: "repository",
      recursionRole: "root",
      threadId: undefined,
      wikiGoalOverride: plan.rootGoal,
      // Repo setup already ran once above; don't repeat it per sub-run.
      skipRepoSetup: true,
    },
    // The root run is the one the caller's telemetry boundary records.
    telemetryContext,
  );

  return { subprojectResults, rootResult, skippedWorkspaces, failedWorkspaces };
}

/**
 * Writes the deterministic aggregation page openwiki/workspaces.md at the repo
 * root, linking down to each subproject's sub-wiki entrypoint. Includes valid
 * OKF front matter (type: Reference) so migrateWikiToOkf does not rewrite or
 * retag it during the root run.
 */
export async function writeRootAggregation(
  repoRoot: string,
  plan: ResolvedWorkspacePlan,
): Promise<void> {
  const openWikiDir = path.join(repoRoot, "openwiki");

  const rows = plan.runs
    .map((run) => {
      const label = run.name ?? run.relativePath;
      const href = `../${run.relativePath}/openwiki/quickstart.md`;
      const goal = run.goal ? ` — ${escapeTableCell(run.goal)}` : "";
      return `- [${escapeLinkLabel(label)}](${encodeSubwikiHref(href)})${goal}`;
    })
    .join("\n");

  const content = `---
type: Reference
title: Workspaces
description: Generated index of this monorepo's subproject sub-wikis. Each entry links to that subproject's own OpenWiki quickstart.
---

# Workspaces

This monorepo documents each subproject in its own OpenWiki sub-wiki. This page is generated automatically; do not hand-edit the list below.

${rows || "No documented subprojects."}
`;

  await writeGeneratedFile(
    repoRoot,
    path.join(openWikiDir, "workspaces.md"),
    content,
  );
}

/**
 * URL-encodes each path segment of a sub-wiki href while preserving separators.
 */
function encodeSubwikiHref(href: string): string {
  return href
    .split("/")
    .map((segment) =>
      segment === ".." ? segment : encodeURIComponent(segment),
    )
    .join("/");
}

function escapeLinkLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function escapeTableCell(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Reads the git HEAD for a directory, returning undefined when not in a repo or
 * git is unavailable. Best-effort; never throws.
 */
async function readGitHead(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-pager", "rev-parse", "HEAD"],
      { cwd },
    );
    const head = stdout.trim();
    return head.length > 0 ? head : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Emits a subproject/root boundary marker as a text event so the CLI can render
 * coherent per-run progress across the sequential recursive pass.
 */
function emitBoundary(options: OpenWikiRunOptions, label: string): void {
  options.onEvent?.({ type: "text", text: `\n=== ${label} ===\n` });
}
