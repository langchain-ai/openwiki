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
import { RepositoryEvidenceResolver } from "../../evidence/repository/resolver.js";
import { runClaimsPreflight } from "./preflight.js";
import { ClaimSession } from "./session.js";
import { ClaimsStore } from "./store.js";

/**
 * Prepared repository Claims state for one init or update run.
 */
export interface ClaimsRuntime {
  /**
   * Run-scoped working state used by tools, middleware, and finalization.
   */
  session: ClaimSession;

  /**
   * Number of lazy page-local issues, used for diagnostics only.
   */
  issueCount: number;

  /**
   * Persists dirty Claims, projects durable verification, and cleans orphans.
   */
  finalize(at?: string): Promise<void>;
}

/**
 * Prepares Claims only for repository init and update runs.
 *
 * Update preparation detects evidence debt for page-local read notes without
 * turning it into mandatory agent work or blocking an update no-op.
 *
 * @param command - Current OpenWiki command.
 * @param outputMode - Current output target.
 * @param cwd - Absolute repository root.
 * @param openWikiIgnore - Repository read-boundary rules.
 * @param onWarning - Optional sink for non-fatal Claims degradation.
 * @returns Prepared Claims runtime, or `undefined` outside code generation.
 */
export async function prepareClaimsRuntime(
  command: OpenWikiCommand,
  outputMode: OpenWikiOutputMode,
  cwd: string,
  openWikiIgnore: OpenWikiIgnore,
  onWarning: (message: string) => void = () => undefined,
): Promise<ClaimsRuntime | undefined> {
  if (outputMode !== "repository" || command === "chat") {
    return undefined;
  }

  const store = new ClaimsStore(cwd);
  const resolver = new RepositoryEvidenceResolver({
    rootDir: cwd,
    openWikiIgnore,
  });

  if (command === "init") {
    const session = new ClaimSession({
      resolver,
      persisted: new Map(),
      issues: [],
      orphanPages: await store.discoverSidecarPages(),
    });
    return {
      session,
      issueCount: 0,
      finalize: async (at = new Date().toISOString()) => {
        const result = await session.finalize(store, {
          by: OPENWIKI_PRODUCER_ACTOR,
          at,
        });
        reportWarnings(result.warnings, onWarning);
        await finalizeVerificationProjection(
          session,
          store,
          result.verificationByPage,
          onWarning,
        );
      },
    };
  }

  const preflight = await runClaimsPreflight(store, resolver);
  const session = new ClaimSession({
    resolver,
    persisted: preflight.persisted,
    issues: preflight.issues,
    orphanPages: preflight.orphanPages,
  });
  return {
    session,
    issueCount: preflight.issues.length,
    finalize: async (at = new Date().toISOString()) => {
      const result = await session.finalize(store, {
        by: OPENWIKI_PRODUCER_ACTOR,
        at,
      });
      reportWarnings(result.warnings, onWarning);
      await finalizeVerificationProjection(
        session,
        store,
        result.verificationByPage,
        onWarning,
      );
    },
  };
}

/**
 * Projects durable verification, synchronizes affected sidecar page hashes,
 * and restores exact Markdown when a page-local hash refresh cannot persist.
 */
async function finalizeVerificationProjection(
  session: ClaimSession,
  store: ClaimsStore,
  verificationByPage: Parameters<typeof synchronizeClaimsVerification>[1],
  onWarning: (message: string) => void,
): Promise<void> {
  const originals = await synchronizeClaimsVerification(
    store,
    verificationByPage,
  );
  const refreshed = await session.refreshPageVersions(store, [
    ...originals.keys(),
  ]);
  const unsafeStamps = refreshed.failedPages.filter(
    (page) =>
      verificationByPage.get(page) !== null &&
      verificationByPage.get(page) !== undefined,
  );
  if (unsafeStamps.length > 0) {
    await rollbackClaimsVerification(store, originals, unsafeStamps);
  }
  reportWarnings(refreshed.warnings, onWarning);
}

/**
 * Delivers best-effort warnings without allowing a diagnostic sink to fail a run.
 *
 * @param warnings - Finalization warnings in stable processing order.
 * @param onWarning - Optional caller-owned warning sink.
 */
function reportWarnings(
  warnings: readonly string[],
  onWarning: (message: string) => void,
): void {
  for (const warning of warnings) {
    try {
      onWarning(warning);
    } catch {
      // Diagnostics must not turn successful fallback into a failed run.
    }
  }
}
