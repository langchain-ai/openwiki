import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  normalizeClaimsToolPagePath,
  normalizeWikiPagePath,
} from "../claims/brains/code/paths.js";
import type { ClaimSession } from "../claims/brains/code/session.js";
import type {
  GroundingIssue,
  InspectedClaim,
} from "../claims/brains/code/types.js";
import type { ClaimOperation } from "../claims/core/types.js";
import { RepositoryRunError } from "./errors.js";
import type {
  PageJob,
  RepositoryRunMode,
  RepositoryRunPlan,
} from "./run-state.js";

/**
 * Model/host proposal for one final generated Markdown page.
 */
export interface ProposedPlanPage {
  /**
   * Canonical or normalizable virtual Markdown path below `/openwiki/`.
   */
  path: string;

  /**
   * Human-readable title for the generated page.
   */
  title: string;

  /**
   * Page-specific documentation objective.
   */
  purpose: string;

  /**
   * Repository-relative starting points for page research.
   */
  seedPaths?: string[];

  /**
   * Generated pages whose context is relevant to this job.
   */
  relatedPages?: string[];

  /**
   * Relevant global constraints that the page worker must follow.
   */
  instructions?: string[];
}

/**
 * One proposed material proposition with code-owned evidence versions omitted.
 */
export interface ProposedPageClaim {
  /**
   * Stable Claim identifier, generated when the proposal omits it.
   */
  id?: string;

  /**
   * Material factual proposition asserted by the completed page.
   */
  statement: string;

  /**
   * Complete evidence-resource set supporting the proposition.
   */
  evidence: Array<{
    /**
     * Canonical repository evidence resource resolved by Claims.
     */
    resource: string;
  }>;
}

/**
 * Complete planner submission before normalization and required-job insertion.
 */
export interface ProposedRepositoryPlan {
  /**
   * Proposed ordered page queue before validation and augmentation.
   */
  pages: ProposedPlanPage[];

  /**
   * Existing generated pages explicitly selected for deletion.
   */
  deletePages?: string[];
}

/**
 * Validates and deterministically normalizes the persisted ordered page queue.
 *
 * @param mode - Repository lifecycle mode owning the proposed plan.
 * @param proposed - Complete proposed page and deletion set.
 * @param claimIssues - Stable preflight issues that require page work.
 * @param requiredRewritePages - Existing pages requiring language rewrites.
 * @returns Complete normalized plan ready for durable persistence.
 * @throws RepositoryRunError when paths, deletion intent, or init shape is invalid.
 */
export function createRepositoryPlan(
  mode: RepositoryRunMode,
  proposed: ProposedRepositoryPlan,
  claimIssues: readonly GroundingIssue[],
  requiredRewritePages: readonly string[] = [],
): RepositoryRunPlan {
  const pages = proposed.pages.map(normalizePlanPage);
  const deletePages = uniqueSorted(
    (proposed.deletePages ?? []).map(normalizePlanPagePath),
  );

  if (mode === "init" && deletePages.length > 0) {
    throw new RepositoryRunError(
      "invalid_input",
      "Init plans cannot delete generated pages.",
    );
  }

  if (deletePages.includes("/openwiki/quickstart.md")) {
    throw new RepositoryRunError(
      "invalid_input",
      "The canonical /openwiki/quickstart.md page cannot be deleted.",
    );
  }

  const pagePaths = new Set<string>();
  for (const page of pages) {
    if (pagePaths.has(page.path)) {
      throw new RepositoryRunError(
        "invalid_input",
        `Duplicate planned page: ${page.path}`,
      );
    }
    pagePaths.add(page.path);
  }

  for (const deleted of deletePages) {
    if (pagePaths.has(deleted)) {
      throw new RepositoryRunError(
        "invalid_input",
        `A page cannot be both generated and deleted: ${deleted}`,
      );
    }
  }

  if (mode === "init" && !pagePaths.has("/openwiki/quickstart.md")) {
    throw new RepositoryRunError(
      "invalid_input",
      "Init plan must include /openwiki/quickstart.md.",
    );
  }

  if (mode === "update") {
    const deleted = new Set(deletePages);
    addRequiredClaimIssueJobs(pages, pagePaths, deleted, claimIssues);
    addRequiredRewriteJobs(pages, pagePaths, deleted, requiredRewritePages);
  }

  // Quickstart is the synthesis/navigation page; generate it after domain pages.
  pages.sort((left, right) => {
    const leftQuickstart = left.path === "/openwiki/quickstart.md";
    const rightQuickstart = right.path === "/openwiki/quickstart.md";
    if (leftQuickstart !== rightQuickstart) return leftQuickstart ? 1 : -1;
    return compareCodeUnits(left.path, right.path);
  });

  return { pages, deletePages };
}

/**
 * Validates and canonicalizes one proposed page into a pending queue job.
 *
 * @param page - Model/host page proposal.
 * @returns Normalized pending page job.
 */
function normalizePlanPage(page: ProposedPlanPage): PageJob {
  const canonicalPath = normalizePlanPagePath(page.path);
  const title = page.title.trim();
  const purpose = page.purpose.trim();
  if (!title || !purpose) {
    throw new RepositoryRunError(
      "invalid_input",
      `Planned page requires title and purpose: ${canonicalPath}`,
    );
  }

  return {
    id: randomUUID(),
    path: canonicalPath,
    title,
    purpose,
    seedPaths: uniqueSorted((page.seedPaths ?? []).map(normalizeSeedPath)),
    relatedPages: uniqueSorted(
      (page.relatedPages ?? []).map(normalizePlanPagePath),
    ),
    instructions: uniqueSorted(
      (page.instructions ?? [])
        .map((instruction) => instruction.trim())
        .filter(Boolean),
    ),
    status: "pending",
  };
}

/**
 * Converts one proposed wiki page path into its canonical non-working form.
 *
 * @param value - Candidate generated Markdown path.
 * @returns Canonical factual page path.
 */
function normalizePlanPagePath(value: string): string {
  try {
    const canonical = normalizeClaimsToolPagePath(value);
    if (path.posix.basename(canonical).startsWith("_")) {
      throw new Error("reserved working page");
    }
    return canonical;
  } catch {
    throw new RepositoryRunError(
      "invalid_input",
      `Invalid or reserved OpenWiki page path: ${value}`,
    );
  }
}

/**
 * Inserts jobs required to reconcile unresolved Claims omitted by the planner.
 *
 * @param pages - Mutable normalized page queue.
 * @param pagePaths - Canonical paths already present in the queue.
 * @param deletePages - Canonical paths explicitly selected for deletion.
 * @param issues - Stable preflight issues grouped into required page work.
 */
function addRequiredClaimIssueJobs(
  pages: PageJob[],
  pagePaths: Set<string>,
  deletePages: Set<string>,
  issues: readonly GroundingIssue[],
): void {
  const grouped = new Map<string, GroundingIssue[]>();
  for (const issue of issues) {
    const page = normalizeWikiPagePath(issue.page);
    const list = grouped.get(page) ?? [];
    list.push(issue);
    grouped.set(page, list);
  }

  for (const [page, pageIssues] of grouped) {
    if (pagePaths.has(page) || deletePages.has(page)) continue;

    pages.push({
      id: randomUUID(),
      path: page,
      title: titleFromPath(page),
      purpose:
        "Reconcile stale or unresolved Claims and update this page from current repository evidence while preserving unaffected accurate content.",
      seedPaths: uniqueSorted(
        pageIssues.flatMap((issue) =>
          issue.resources.map(evidenceResourceToSeedPath),
        ),
      ),
      relatedPages: [],
      instructions: [],
      status: "pending",
    });
    pagePaths.add(page);
  }
}

/**
 * Inserts rewrite jobs required by a documentation-language change.
 *
 * @param pages - Mutable normalized page queue.
 * @param pagePaths - Canonical paths already present in the queue.
 * @param deletePages - Canonical paths explicitly selected for deletion.
 * @param requiredPages - Existing pages that must be rewritten.
 */
function addRequiredRewriteJobs(
  pages: PageJob[],
  pagePaths: Set<string>,
  deletePages: Set<string>,
  requiredPages: readonly string[],
): void {
  for (const pageInput of requiredPages) {
    const page = normalizeWikiPagePath(pageInput);
    if (pagePaths.has(page) || deletePages.has(page)) continue;

    pages.push({
      id: randomUUID(),
      path: page,
      title: titleFromPath(page),
      purpose:
        "Rewrite this existing page in the run's target language while preserving every accurate repository-supported fact and reconciling its complete Claim set.",
      seedPaths: [],
      relatedPages: [],
      instructions: [],
      status: "pending",
    });
    pagePaths.add(page);
  }
}

/**
 * Normalizes one non-escaping repository-relative research seed path.
 *
 * @param value - Candidate repository-relative seed path.
 * @returns Slash-normalized non-empty seed path.
 */
function normalizeSeedPath(value: string): string {
  const trimmed = value.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (!trimmed || trimmed.split("/").some((part) => part === "..")) {
    throw new RepositoryRunError(
      "invalid_input",
      `Invalid seed path: ${value}`,
    );
  }
  return trimmed;
}

/**
 * Converts a repository evidence resource into a page-job seed path.
 *
 * @param resource - Repository evidence URI with an optional line fragment.
 * @returns Repository-relative seed path without its line fragment.
 */
function evidenceResourceToSeedPath(resource: string): string {
  const withoutScheme = resource.replace(/^repo:\/\//u, "");
  return normalizeSeedPath(withoutScheme.replace(/#L\d+(?:-L\d+)?$/u, ""));
}

/**
 * Derives a readable fallback title from a canonical Markdown page path.
 *
 * @param page - Canonical factual Markdown path.
 * @returns Title-cased basename without its extension.
 */
function titleFromPath(page: string): string {
  const basename = path.posix.basename(page, ".md");
  return basename
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

/**
 * Compares strings by deterministic JavaScript UTF-16 code-unit order.
 *
 * @param left - Left comparison value.
 * @param right - Right comparison value.
 * @returns Negative, zero, or positive ordering result.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Returns unique strings in deterministic code-unit order.
 *
 * @param values - Candidate values that may contain duplicates.
 * @returns Deduplicated, deterministically sorted values.
 */
function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

/**
 * Reconciles one page's complete proposed Claim set into session operations.
 *
 * Exact no-ID matches preserve IDs; omitted existing Claims are retracted.
 *
 * @param session - Active process-local Claims session.
 * @param pageInput - Page owning the complete proposed Claim set.
 * @param proposedInput - Complete replacement Claim proposals for the page.
 */
export async function replacePageClaims(
  session: ClaimSession,
  pageInput: string,
  proposedInput: readonly ProposedPageClaim[],
): Promise<void> {
  const page = normalizeWikiPagePath(pageInput);
  const existing = session.inspectClaims(page);
  const existingById = new Map(existing.map((claim) => [claim.id, claim]));
  const usedExistingIds = new Set<string>();
  const proposedFingerprints = new Set<string>();
  const operations: ClaimOperation[] = [];

  for (const raw of proposedInput) {
    const proposed = normalizeProposedClaim(raw);
    const fingerprint = claimFingerprint(proposed.statement, proposed.evidence);
    if (proposedFingerprints.has(fingerprint)) {
      throw new RepositoryRunError(
        "invalid_input",
        `Duplicate proposed Claim for ${page}: ${proposed.statement}`,
      );
    }
    proposedFingerprints.add(fingerprint);

    if (proposed.id) {
      const current = existingById.get(proposed.id);
      if (!current) {
        throw new RepositoryRunError(
          "invalid_input",
          `Claim ${proposed.id} is not owned by ${page}.`,
        );
      }
      if (usedExistingIds.has(current.id)) {
        throw new RepositoryRunError(
          "invalid_input",
          `Claim ${current.id} was proposed more than once for ${page}.`,
        );
      }
      usedExistingIds.add(current.id);

      if (sameClaim(current, proposed)) {
        operations.push({ op: "confirm", id: current.id });
      } else {
        const statementChanged = current.statement !== proposed.statement;
        const evidenceChanged = !sameEvidence(
          current.evidence,
          proposed.evidence,
        );
        operations.push({
          op: "update",
          id: current.id,
          ...(statementChanged ? { statement: proposed.statement } : {}),
          ...(evidenceChanged ? { evidence: proposed.evidence } : {}),
        });
      }
      continue;
    }

    const exactExisting = existing.find(
      (candidate) =>
        !usedExistingIds.has(candidate.id) && sameClaim(candidate, proposed),
    );
    if (exactExisting) {
      usedExistingIds.add(exactExisting.id);
      operations.push({ op: "confirm", id: exactExisting.id });
    } else {
      operations.push({
        op: "add",
        statement: proposed.statement,
        evidence: proposed.evidence,
      });
    }
  }

  for (const current of existing) {
    if (!usedExistingIds.has(current.id)) {
      operations.push({ op: "retract", id: current.id });
    }
  }

  if (operations.length > 0) {
    await session.resolveClaims({ page, operations });
  }
}

/**
 * Validates and canonicalizes one model-proposed Claim.
 *
 * @param claim - Raw page Claim proposal.
 * @returns Trimmed statement, optional identifier, and canonical evidence set.
 */
function normalizeProposedClaim(claim: ProposedPageClaim): {
  id?: string;
  statement: string;
  evidence: Array<{ resource: string }>;
} {
  const statement = claim.statement.trim();
  if (!statement) {
    throw new RepositoryRunError("invalid_input", "Claim statement is empty.");
  }

  const resources = uniqueSorted(
    claim.evidence.map(({ resource }) => resource.trim()).filter(Boolean),
  );
  if (resources.length === 0) {
    throw new RepositoryRunError(
      "invalid_input",
      `Claim requires repository evidence: ${statement}`,
    );
  }

  return {
    ...(claim.id?.trim() ? { id: claim.id.trim() } : {}),
    statement,
    evidence: resources.map((resource) => ({ resource })),
  };
}

/**
 * Compares a persisted Claim with one normalized proposal by full content.
 *
 * @param existing - Current model-facing Claim state.
 * @param proposed - Normalized replacement proposal.
 * @returns Whether statement and evidence sets are identical.
 */
function sameClaim(
  existing: InspectedClaim,
  proposed: { statement: string; evidence: Array<{ resource: string }> },
): boolean {
  return (
    existing.statement === proposed.statement &&
    sameEvidence(existing.evidence, proposed.evidence)
  );
}

/**
 * Compares evidence resources as canonical sets independent of input order.
 *
 * @param existing - Existing resolver resource identities.
 * @param proposed - Normalized proposed evidence resources.
 * @returns Whether both inputs contain the same unique resources.
 */
function sameEvidence(
  existing: readonly string[],
  proposed: readonly { resource: string }[],
): boolean {
  const left = uniqueSorted([...existing]);
  const right = uniqueSorted(proposed.map(({ resource }) => resource));
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
  );
}

/**
 * Produces a deterministic exact-match key for a statement and evidence set.
 *
 * @param statement - Normalized material proposition.
 * @param evidence - Normalized evidence-resource set.
 * @returns Collision-safe serialized Claim identity.
 */
function claimFingerprint(
  statement: string,
  evidence: readonly { resource: string }[],
): string {
  return JSON.stringify([
    statement,
    uniqueSorted(evidence.map(({ resource }) => resource)),
  ]);
}
