import type {
  OpenWikiCommand,
  OpenWikiOutputMode,
} from "../../../agent/types.js";
import { OpenWikiIgnore } from "../../../agent/openwiki-ignore.js";
import {
  rollbackClaimsVerification,
  synchronizeClaimsVerification,
} from "../../../okf/claims-verification.js";
import { OPENWIKI_PRODUCER_ACTOR } from "../../../version.js";
import { ClaimsPersistenceError } from "../../core/errors.js";
import { RepositoryEvidenceResolver } from "../../evidence/repository/resolver.js";
import { runClaimsPreflight } from "./preflight.js";
import { ClaimSession } from "./session.js";
import { ClaimsStore } from "./store.js";
import type { GroundingIssue } from "./types.js";

/**
 * Strict repository Claims state rebuilt for each active process.
 */
export interface ClaimsRuntime {
  /**
   * Process-local Claim session for inspecting and replacing page Claims.
   */
  session: ClaimSession;

  /**
   * Number of stable preflight issues detected when the runtime was prepared.
   */
  issueCount: number;

  /**
   * Stable preflight issues supplied to planning and required-page augmentation.
   */
  issues: readonly GroundingIssue[];

  /**
   * Persists Claims and synchronizes verification/page versions or rejects.
   */
  finalize(at?: string, excludedPages?: ReadonlySet<string>): Promise<void>;
}

/**
 * Preparation behavior that differs only when resuming an interrupted init.
 */
export interface PrepareClaimsRuntimeOptions {
  /**
   * Load current-run sidecars instead of starting with empty init state.
   */
  resumeInit?: boolean;
}

/**
 * Builds strict Claims state for repository init/update.
 *
 * @param command - Current OpenWiki command.
 * @param outputMode - Current output target.
 * @param cwd - Absolute repository root.
 * @param openWikiIgnore - Repository read-boundary rules.
 * @param onWarning - Optional sink notified before strict warning rejection.
 * @param options - Fresh-init or resumed-init preparation behavior.
 * @returns `undefined` outside repository generation.
 */
export async function prepareClaimsRuntime(
  command: OpenWikiCommand,
  outputMode: OpenWikiOutputMode,
  cwd: string,
  openWikiIgnore: OpenWikiIgnore,
  onWarning: (message: string) => void = () => undefined,
  options: PrepareClaimsRuntimeOptions = {},
): Promise<ClaimsRuntime | undefined> {
  if (outputMode !== "repository" || command === "chat") {
    return undefined;
  }

  const store = new ClaimsStore(cwd);
  const resolver = new RepositoryEvidenceResolver({
    rootDir: cwd,
    openWikiIgnore,
  });

  const freshInit = command === "init" && options.resumeInit !== true;

  if (freshInit) {
    const session = new ClaimSession({
      resolver,
      persisted: new Map(),
      issues: [],
      orphanPages: await store.discoverSidecarPages(),
    });
    return buildClaimsRuntime(session, [], store, onWarning);
  }

  const preflight = await runClaimsPreflight(store, resolver);
  const session = new ClaimSession({
    resolver,
    persisted: preflight.persisted,
    issues: preflight.issues,
    orphanPages: preflight.orphanPages,
  });
  return buildClaimsRuntime(session, preflight.issues, store, onWarning);
}

/**
 * Binds a Claim session to strict persistence and verification finalization.
 *
 * @param session - Process-local Claims working state.
 * @param issues - Stable preflight issues exposed to planning.
 * @param store - Repository Claims persistence boundary.
 * @param onWarning - Caller-owned strict-warning notification sink.
 * @returns Runtime facade used by the repository lifecycle.
 */
function buildClaimsRuntime(
  session: ClaimSession,
  issues: readonly GroundingIssue[],
  store: ClaimsStore,
  onWarning: (message: string) => void,
): ClaimsRuntime {
  return {
    session,
    issueCount: issues.length,
    issues: [...issues],
    finalize: async (
      at = new Date().toISOString(),
      excludedPages: ReadonlySet<string> = new Set(),
    ) => {
      const result = await session.finalize(
        store,
        {
          by: OPENWIKI_PRODUCER_ACTOR,
          at,
        },
        excludedPages,
      );
      const warnings = [...result.warnings];
      warnings.push(
        ...(await finalizeVerificationProjection(
          session,
          store,
          result.verificationByPage,
        )),
      );
      for (const warning of warnings) onWarning(warning);
      if (warnings.length > 0) {
        throw new ClaimsPersistenceError(
          `Claims finalization was not fully durable: ${warnings.join("; ")}`,
        );
      }
    },
  };
}

/**
 * Synchronizes verification metadata and rolls back stamps with stale versions.
 *
 * @param session - Process-local Claims working state.
 * @param store - Repository Claims and Markdown persistence boundary.
 * @param verificationByPage - Durable verification eligibility by factual page.
 * @returns Page-version synchronization warnings requiring run failure.
 */
async function finalizeVerificationProjection(
  session: ClaimSession,
  store: ClaimsStore,
  verificationByPage: Parameters<typeof synchronizeClaimsVerification>[1],
): Promise<string[]> {
  const originals = await synchronizeClaimsVerification(
    store,
    verificationByPage,
  );
  // Deterministic finalizers may have changed code-owned frontmatter without
  // changing the verification event. Refresh every represented page so Claims
  // sidecars always describe the final Markdown bytes.
  const refreshed = await session.refreshPageVersions(store, [
    ...verificationByPage.keys(),
  ]);
  const unsafeStamps = refreshed.failedPages.filter(
    (page) =>
      verificationByPage.get(page) !== null &&
      verificationByPage.get(page) !== undefined,
  );
  if (unsafeStamps.length > 0) {
    await rollbackClaimsVerification(store, originals, unsafeStamps);
  }
  return [...refreshed.warnings];
}
