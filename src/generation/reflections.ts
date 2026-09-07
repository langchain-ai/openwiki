import type { OpenWikiIgnore } from "../agent/openwiki-ignore.js";
import type { PageProse } from "../claims/brains/code/prose-types.js";
import { ClaimsError } from "../claims/core/errors.js";
import type { Claim } from "../claims/core/types.js";
import { RepositoryEvidenceResolver } from "../claims/evidence/repository/resolver.js";
import {
  REFLECTION_ID_PATTERN,
  type Reflection,
} from "../memory/reflection-types.js";
import { ReflectionStore } from "../memory/reflections.js";
import { RepositoryRunError } from "./errors.js";
import type { PageJob } from "./run-state.js";

/**
 * Temporary author decision validated against the resulting page and never persisted.
 */
export interface ReflectionResult {
  /**
   * Identity of a pending reflection assigned to this page.
   */
  id: string;

  /**
   * Resulting claim IDs or exact statements; an empty list discards the finding.
   */
  claims: string[];
}

/**
 * Pending discovery with source availability checked against its captured evidence.
 */
export interface InspectedReflection {
  /**
   * Stable identity used for planning and page submission.
   */
  id: string;

  /**
   * Provisional discovery and its conditions, to verify against current code.
   */
  finding: string;

  /**
   * Source resources with explicit changed or unresolved evidence feedback.
   */
  evidence: Array<{
    /**
     * Canonical captured repository resource.
     */
    resource: string;

    /**
     * Why captured evidence needs attention; absence means its version still matches.
     */
    issue?: "changed" | "unresolved";
  }>;
}

/**
 * Loads pending work without silently excluding malformed captured records.
 *
 * @param root - Absolute repository root.
 * @param ids - Optional starting set; omitted only when capturing a new update.
 * @returns Readable pending records, excluding later arrivals when a scope is supplied.
 */
export async function loadPendingReflections(
  root: string,
  ids?: readonly string[],
): Promise<Reflection[]> {
  const inventory = await new ReflectionStore(root).list(ids);
  if (inventory.unavailable)
    throw new RepositoryRunError(
      "invalid_state",
      `${inventory.unavailable} Restore the pending files and retry the update; no unreadable reflection is treated as processed.`,
    );
  return inventory.reflections;
}

/**
 * Projects pending discoveries for planners and page authors without opaque versions.
 *
 * @param root - Absolute repository root.
 * @param ignore - Current source visibility boundary.
 * @param ids - Captured scope for this run or page.
 * @returns Provisional findings with current evidence feedback.
 */
export async function inspectReflections(
  root: string,
  ignore: OpenWikiIgnore,
  ids: readonly string[],
): Promise<InspectedReflection[]> {
  const reflections = await loadPendingReflections(root, ids);
  const resolver = new RepositoryEvidenceResolver({
    rootDir: root,
    openWikiIgnore: ignore,
  });
  const result: InspectedReflection[] = [];
  for (const reflection of reflections) {
    const evidence: InspectedReflection["evidence"] = [];
    for (const captured of reflection.evidence) {
      try {
        const current = await resolver.resolve(
          captured.resource,
          captured.version,
        );
        evidence.push({
          resource: current?.evidence.resource ?? captured.resource,
          ...(!current
            ? { issue: "unresolved" as const }
            : current.evidence.version !== captured.version
              ? { issue: "changed" as const }
              : {}),
        });
      } catch (error) {
        if (!(error instanceof ClaimsError)) throw error;
        evidence.push({ resource: captured.resource, issue: "unresolved" });
      }
    }
    result.push({ id: reflection.id, finding: reflection.finding, evidence });
  }
  return result;
}

/**
 * Requires one planning decision for every still-pending captured discovery.
 *
 * @param pages - Normalized page jobs with optional reflection assignments.
 * @param discarded - Findings checked and discarded during planning.
 * @param capturedIds - Original run scope, including records already removed on a retry.
 * @param pending - Captured records that still require processing.
 */
export function validateReflectionPlan(
  pages: readonly PageJob[],
  discarded: readonly string[],
  capturedIds: readonly string[],
  pending: readonly Reflection[],
): void {
  const captured = new Set(capturedIds);
  const decided = new Set<string>();
  for (const id of [
    ...pages.flatMap((page) => page.reflectionIds ?? []),
    ...discarded,
  ]) {
    if (!captured.has(id) || !REFLECTION_ID_PATTERN.test(id))
      throw new RepositoryRunError(
        "invalid_input",
        `Reflection ${id} is outside this update's captured set. Use the reflections returned by begin.`,
      );
    if (decided.has(id))
      throw new RepositoryRunError(
        "invalid_input",
        `Reflection ${id} has more than one planning decision. Assign it to one page or discard it once.`,
      );
    decided.add(id);
  }
  const omitted = pending.filter(({ id }) => !decided.has(id));
  if (omitted.length)
    throw new RepositoryRunError(
      "invalid_input",
      `Every captured reflection requires a decision. Assign these IDs to a page's reflectionIds or include them in discardedReflectionIds after checking their evidence: ${omitted.map(({ id }) => id).join(", ")}.`,
    );
}

/**
 * Validates temporary outcomes before any resulting claim or prose state is applied.
 *
 * @param results - Author decisions, never persisted as a mapping or ledger.
 * @param assignedIds - Identities owned by this page, including already-deleted retry work.
 * @param pending - Assigned records still on disk when submission began.
 * @param claims - Complete prospective claims after sparse reconciliation.
 * @param prose - Complete validated sections and bindings for the finished page.
 */
export function validateReflectionResults(
  results: readonly ReflectionResult[],
  assignedIds: readonly string[],
  pending: readonly Reflection[],
  claims: readonly Claim[],
  prose?: PageProse,
): void {
  const assigned = new Set(assignedIds);
  const decided = new Set<string>();
  for (const result of results) {
    if (!assigned.has(result.id) || decided.has(result.id))
      throw new RepositoryRunError(
        "invalid_input",
        `Reflection ${result.id} must belong to this page and receive exactly one reflectionResults entry.`,
      );
    decided.add(result.id);
    const linked = new Set<string>();
    for (const reference of result.claims) {
      const byId = claims.find(({ id }) => id === reference);
      const matches = byId
        ? [byId]
        : claims.filter(({ statement }) => statement === reference);
      if (
        matches.length !== 1 ||
        !prose?.bindings.some(({ claimIds }) =>
          claimIds.includes(matches[0].id),
        )
      )
        throw new RepositoryRunError(
          "invalid_input",
          `Reflection ${result.id} must reference an unambiguous resulting claim bound to this page's prose: ${reference}. Use a claim ID or exact new statement; use claims: [] only after discarding the finding.`,
        );
      if (linked.has(matches[0].id))
        throw new RepositoryRunError(
          "invalid_input",
          `Reflection ${result.id} repeats the same resulting claim.`,
        );
      linked.add(matches[0].id);
    }
  }
  const omitted = pending.filter(({ id }) => !decided.has(id));
  if (omitted.length)
    throw new RepositoryRunError(
      "invalid_input",
      `Submit one reflectionResults entry for each pending finding: ${omitted.map(({ id }) => id).join(", ")}. Reference resulting claims for incorporated or duplicate knowledge, or claims: [] for discarded findings.`,
    );
}

/**
 * Deletes only the exact successfully evaluated records; failures keep the run resumable.
 *
 * @param root - Absolute repository root.
 * @param reflections - Successfully evaluated immutable records.
 */
export async function removeProcessedReflections(
  root: string,
  reflections: readonly Reflection[],
): Promise<void> {
  const store = new ReflectionStore(root);
  for (const reflection of reflections) {
    try {
      await store.remove(reflection);
    } catch (error) {
      throw new RepositoryRunError(
        "invalid_state",
        error instanceof Error
          ? error.message
          : "Reflection cleanup failed. Retry the update; pending files remain the work to process.",
      );
    }
  }
}
