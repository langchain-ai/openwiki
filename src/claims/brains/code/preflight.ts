import { cacheEvidenceResolver } from "../../core/resolver-cache.js";
import type { EvidenceResolver } from "../../core/types.js";
import type { GroundingIssue, PageClaims } from "./types.js";
import { ClaimsStore } from "./store.js";

/**
 * Complete deterministic Claims preflight used by repository planning.
 */
export interface ClaimsPreflightResult {
  /**
   * Complete deterministic grounding issues found during preflight.
   */
  issues: GroundingIssue[];

  /**
   * Persisted Claims sidecars keyed by canonical page path.
   */
  persisted: Map<string, PageClaims>;

  /**
   * Canonical Claims sidecars whose generated pages no longer exist.
   */
  orphanPages: string[];
}

/**
 * Runs global claim freshness checks without creating mandatory agent work.
 *
 * Each evidence resource and prior version resolves once per preflight.
 * Resolution errors propagate so they cannot be mistaken for deleted evidence.
 *
 * @param store - Repository claim persistence.
 * @param resolver - Repository evidence resolver.
 * @returns Persisted state, orphan inventory, and stable-order issues.
 */
export async function runClaimsPreflight(
  store: ClaimsStore,
  resolver: EvidenceResolver,
): Promise<ClaimsPreflightResult> {
  const pages = await store.discoverPages();
  const persisted = await store.loadPages(pages);
  const pageSet = new Set(pages);
  const orphanPages = (await store.discoverSidecarPages()).filter(
    (page) => !pageSet.has(page),
  );
  const issues: GroundingIssue[] = [];
  const cachedResolver = cacheEvidenceResolver(resolver);

  for (const page of pages) {
    const pageClaims = persisted.get(page);
    if (!pageClaims) {
      continue;
    }

    for (const claim of pageClaims.claims) {
      const changedResources: string[] = [];
      const unresolvedResources: string[] = [];

      for (const evidence of claim.evidence) {
        const current = await cachedResolver.resolve(
          evidence.resource,
          evidence.version,
        );
        if (!current) {
          unresolvedResources.push(evidence.resource);
        } else if (current.evidence.version !== evidence.version) {
          changedResources.push(evidence.resource);
        }
      }

      if (unresolvedResources.length > 0) {
        issues.push({
          page,
          kind: "unresolved",
          claimId: claim.id,
          resources: unresolvedResources.sort(),
        });
      } else if (changedResources.length > 0) {
        issues.push({
          page,
          kind: "stale",
          claimId: claim.id,
          resources: changedResources.sort(),
        });
      }
    }
  }

  issues.sort(compareGroundingIssues);
  orphanPages.sort((left, right) => left.localeCompare(right));
  return {
    issues,
    persisted,
    orphanPages,
  };
}

/**
 * Produces deterministic page-read and test ordering for grounding issues.
 *
 * @param left - First issue.
 * @param right - Second issue.
 * @returns Standard array-sort comparison.
 */
function compareGroundingIssues(
  left: GroundingIssue,
  right: GroundingIssue,
): number {
  return (
    left.page.localeCompare(right.page) ||
    left.kind.localeCompare(right.kind) ||
    (left.claimId ?? "").localeCompare(right.claimId ?? "")
  );
}
