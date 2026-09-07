import { OpenWikiIgnore } from "../agent/openwiki-ignore.js";
import { readLastUpdate } from "../agent/utils.js";
import type { PageClaims } from "../claims/brains/code/types.js";
import { ClaimsStore } from "../claims/brains/code/store.js";
import {
  formatRepositoryEvidenceResource,
  parseRepositoryEvidenceResource,
} from "../claims/evidence/repository/resource.js";
import {
  readRepositoryPageManifest,
  type RepositoryPageManifest,
} from "../generation/page-manifest.js";
import {
  MemoryComparisonError,
  MemoryGit,
  type GitMemoryChange,
} from "./git.js";
import type {
  MemoryChanges,
  MemoryLayer,
  ShortTermChange,
  WikiClaimChange,
  WikiPageChange,
  WikiSectionChange,
} from "./types.js";

/**
 * Scope known from the long-term payload, with read selectors already expanded.
 */
export interface KnowledgeScope {
  /**
   * Wiki-relative page paths in the requested scope.
   */
  pages: readonly string[];

  /**
   * Whether repository-wide changes without known wiki connections are included.
   */
  repositoryWide: boolean;

  /**
   * Selected section identities and descendants, or undefined for complete pages.
   */
  sectionIds?: ReadonlySet<string>;
}

/**
 * Evidence-path relationships restricted to the calling tool's knowledge scope.
 */
export interface PageConnections {
  /**
   * Wiki-relative owner page.
   */
  page: string;

  /**
   * Source paths mapped to their affected claim and section identities.
   */
  paths: Map<
    string,
    {
      /**
       * Claims supported by this evidence file.
       */
      claimIds: string[];

      /**
       * Sections whose bindings express those claims.
       */
      sectionIds: string[];
    }
  >;
}

/**
 * Internal connected change projected differently by each navigation tool.
 */
interface ConnectedChange extends GitMemoryChange, KnowledgeConnections {
  /**
   * Main-history incorporation; ignored when projecting the working layer.
   */
  inCheckout: boolean;
}

/**
 * Stable wiki relationships shared by source-change and reflection retrieval.
 */
export interface KnowledgeConnections {
  /**
   * Affected wiki-relative pages in stable order.
   */
  pages: string[];

  /**
   * Affected section identities in stable order.
   */
  sectionIds: string[];

  /**
   * Affected claim identities in stable order.
   */
  claimIds: string[];
}

/**
 * Returns repository-wide changes, retaining resources with no known wiki connection.
 *
 * @param root - Absolute repository root.
 * @param pages - Complete factual page directory returned by orient.
 * @returns Change layers connected to affected pages.
 */
export function orientChanges(
  root: string,
  pages: readonly string[],
): Promise<MemoryChanges<WikiPageChange>> {
  return changesForScope(root, { pages, repositoryWide: true }, (change) => ({
    resource: formatRepositoryEvidenceResource({ path: change.path }),
    affectedPages: change.pages,
  }));
}

/**
 * Returns changes connected to a page's sections through its claims and bindings.
 *
 * @param root - Absolute repository root.
 * @param page - Wiki-relative page returned by outline.
 * @returns Change layers connected to stable section identities.
 */
export function outlineChanges(
  root: string,
  page: string,
): Promise<MemoryChanges<WikiSectionChange>> {
  return changesForScope(
    root,
    { pages: [page], repositoryWide: false },
    (change) => ({
      resource: formatRepositoryEvidenceResource({ path: change.path }),
      affectedSectionIds: change.sectionIds,
    }),
  );
}

/**
 * Returns changed source resources connected to the sections included in a read.
 *
 * @param root - Absolute repository root.
 * @param page - Wiki-relative page returned by read.
 * @param sectionIds - Expanded section selection, including descendants.
 * @returns Change layers connected to the selected prose's supporting claims.
 */
export function readChanges(
  root: string,
  page: string,
  sectionIds: readonly string[],
): Promise<MemoryChanges<WikiClaimChange>> {
  return changesForScope(
    root,
    {
      pages: [page],
      repositoryWide: false,
      sectionIds: new Set(sectionIds),
    },
    (change) => ({
      resource: formatRepositoryEvidenceResource({ path: change.path }),
      affectedClaimIds: change.claimIds,
    }),
  );
}

/**
 * Computes independent comparison layers while preserving readable long-term knowledge.
 *
 * @param root - Absolute repository root.
 * @param scope - Requested page and section scope.
 * @param project - Tool-specific compact change projection.
 * @returns Both layers, with comparison gaps represented explicitly.
 */
async function changesForScope<T>(
  root: string,
  scope: KnowledgeScope,
  project: (change: ConnectedChange) => T,
): Promise<MemoryChanges<T>> {
  try {
    const git = new MemoryGit(root, await OpenWikiIgnore.load(root));
    const main = await git.main();
    const head = await git.head();
    const connections = await loadConnections(root, scope);
    const [shortTerm, working] = await Promise.all([
      compareLayer(async () => {
        const changes = await mainChanges(
          root,
          git,
          main,
          head,
          connections,
          scope,
        );
        return changes.map((change): ShortTermChange<T> => ({
          ...project(change),
          inCheckout: change.inCheckout,
        }));
      }),
      compareLayer(async () => {
        const base = await git.mergeBase(main, head);
        const changes = await git.changes(
          base,
          undefined,
          relevantPaths(connections, scope),
        );
        return changes.map((change) =>
          project(connectChange(change, connections)),
        );
      }),
    ]);
    return { shortTerm, working };
  } catch (error) {
    const unavailable = comparisonFailure(error);
    return { shortTerm: { unavailable }, working: { unavailable } };
  }
}

/**
 * Reads only the claims and bindings needed to connect the requested knowledge.
 *
 * @param root - Absolute repository root.
 * @param scope - Page and optional section selection.
 * @returns Page-local evidence relationships; missing legacy sidecars have no known links.
 */
export async function loadConnections(
  root: string,
  scope: KnowledgeScope,
): Promise<PageConnections[]> {
  const store = new ClaimsStore(root);
  return Promise.all(
    scope.pages.map(async (page) => ({
      page,
      paths: connectPage(
        await store.loadPage(`/openwiki/${page}`),
        scope.sectionIds,
      ),
    })),
  );
}

/**
 * Joins evidence paths to claims and the sections where their bindings express them.
 *
 * File-level connections are deliberately conservative: changing a different
 * range in the same file still identifies evidence worth checking, not a false claim.
 *
 * @param state - Existing page claims and optional prose metadata.
 * @param selected - Selected section IDs, or undefined for all page claims.
 * @returns Evidence paths with deduplicated claim and section identities.
 */
function connectPage(
  state: PageClaims | null,
  selected?: ReadonlySet<string>,
): PageConnections["paths"] {
  const paths: PageConnections["paths"] = new Map();
  for (const claim of state?.claims ?? []) {
    const sectionIds = [
      ...new Set(
        (state?.bindings ?? [])
          .filter(
            (binding) =>
              binding.claimIds.includes(claim.id) &&
              (!selected || selected.has(binding.sectionId)),
          )
          .map(({ sectionId }) => sectionId),
      ),
    ].sort();
    if (selected && sectionIds.length === 0) continue;
    for (const evidence of claim.evidence) {
      const { path } = parseRepositoryEvidenceResource(evidence.resource);
      const existing = paths.get(path) ?? { claimIds: [], sectionIds: [] };
      paths.set(path, {
        claimIds: [...new Set([...existing.claimIds, claim.id])].sort(),
        sectionIds: [
          ...new Set([...existing.sectionIds, ...sectionIds]),
        ].sort(),
      });
    }
  }
  return paths;
}

/**
 * Computes main changes using each page's checkpoint, plus whole-wiki coverage for orient.
 *
 * @param root - Absolute repository root.
 * @param git - Read-only Git query adapter.
 * @param main - Captured default-branch commit.
 * @param head - Captured checkout commit.
 * @param connections - Scoped evidence relationships.
 * @param scope - Requested retrieval scope.
 * @returns Net main changes with page-specific affected relationships.
 */
async function mainChanges(
  root: string,
  git: MemoryGit,
  main: string,
  head: string,
  connections: readonly PageConnections[],
  scope: KnowledgeScope,
): Promise<ConnectedChange[]> {
  const [manifest, lastUpdate] = await Promise.all([
    readRepositoryPageManifest(root),
    readLastUpdate(root, "repository"),
  ]);
  const checkpoints = new Map<string | undefined, PageConnections[]>();
  for (const connection of connections) {
    const checkpoint = pageCheckpoint(
      manifest,
      connection.page,
      lastUpdate?.gitHead,
    );
    checkpoints.set(checkpoint, [
      ...(checkpoints.get(checkpoint) ?? []),
      connection,
    ]);
  }
  // The complete update checkpoint also covers new code that no page claims yet.
  if (
    scope.repositoryWide &&
    lastUpdate?.gitHead &&
    !checkpoints.has(lastUpdate.gitHead)
  ) {
    checkpoints.set(lastUpdate.gitHead, []);
  }
  const groups = new Map<string, PageConnections[]>();
  for (const [checkpoint, pages] of checkpoints) {
    const base = await git.mergeBase(await git.checkpoint(checkpoint), main);
    groups.set(base, [...(groups.get(base) ?? []), ...pages]);
  }
  if (groups.size === 0)
    throw new MemoryComparisonError(
      "The wiki has no source checkpoint available for this comparison.",
    );
  const result = new Map<string, ConnectedChange>();
  for (const [base, pages] of groups) {
    const changes = await git.changes(base, main, relevantPaths(pages, scope));
    for (const change of changes) {
      const connected = connectChange(change, pages);
      connected.inCheckout = await git.inCheckout(
        base,
        main,
        head,
        change.path,
      );
      const existing = result.get(change.path);
      result.set(
        change.path,
        existing
          ? {
              ...connected,
              inCheckout: existing.inCheckout && connected.inCheckout,
              pages: [
                ...new Set([...existing.pages, ...connected.pages]),
              ].sort(),
              sectionIds: [
                ...new Set([...existing.sectionIds, ...connected.sectionIds]),
              ].sort(),
              claimIds: [
                ...new Set([...existing.claimIds, ...connected.claimIds]),
              ].sort(),
            }
          : connected,
      );
    }
  }
  return [...result.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/**
 * Selects explicit per-page coverage before the legacy whole-wiki fallback.
 *
 * @param manifest - Existing page checkpoint manifest.
 * @param page - Wiki-relative page path.
 * @param fallback - Legacy or whole-run source checkpoint.
 * @returns Recorded checkpoint; an explicit entry without a commit stays unavailable.
 */
function pageCheckpoint(
  manifest: RepositoryPageManifest,
  page: string,
  fallback: string | undefined,
): string | undefined {
  const entry = manifest.pages[`/openwiki/${page}`];
  return entry ? entry.gitHead : fallback;
}

/**
 * Restricts page/section tools to their connected source paths.
 *
 * @param pages - Scoped page evidence relationships.
 * @param scope - Whether unconnected repository resources should be included.
 * @returns Evidence-path filter, or undefined for repository-wide orientation.
 */
function relevantPaths(
  pages: readonly PageConnections[],
  scope: KnowledgeScope,
): ReadonlySet<string> | undefined {
  return scope.repositoryWide
    ? undefined
    : new Set(pages.flatMap(({ paths }) => [...paths.keys()]));
}

/**
 * Connects a changed file to the knowledge covered by a comparison window.
 *
 * @param change - Net file change.
 * @param pages - Pages whose checkpoints belong to this comparison.
 * @returns Deduplicated relationships ready for tool-specific projection.
 */
function connectChange(
  change: GitMemoryChange,
  pages: readonly PageConnections[],
): ConnectedChange {
  return {
    ...change,
    inCheckout: false,
    ...connectResources([change.path], pages),
  };
}

/**
 * Connects one or more evidence files to the selected wiki knowledge.
 *
 * @param resources - Repository-relative evidence paths, without line fragments.
 * @param pages - Page-local relationships already narrowed to selected sections.
 * @returns Deduplicated page, section, and claim identities in stable order.
 */
export function connectResources(
  resources: Iterable<string>,
  pages: readonly PageConnections[],
): KnowledgeConnections {
  const paths = [...new Set(resources)];
  const affected = pages
    .map((page) => ({
      page: page.page,
      matches: paths.flatMap((resource) => {
        const match = page.paths.get(resource);
        return match ? [match] : [];
      }),
    }))
    .filter(({ matches }) => matches.length > 0);
  return {
    pages: affected.map(({ page }) => page).sort(),
    sectionIds: [
      ...new Set(
        affected.flatMap(({ matches }) =>
          matches.flatMap(({ sectionIds }) => sectionIds),
        ),
      ),
    ].sort(),
    claimIds: [
      ...new Set(
        affected.flatMap(({ matches }) =>
          matches.flatMap(({ claimIds }) => claimIds),
        ),
      ),
    ].sort(),
  };
}

/**
 * Preserves the other layers when one comparison cannot be completed.
 *
 * @param operation - Complete layer comparison; partial lists are never presented as complete.
 * @returns Changes or a bounded unavailable explanation.
 */
async function compareLayer<T>(
  operation: () => Promise<T[]>,
): Promise<MemoryLayer<T>> {
  try {
    return { changes: await operation() };
  } catch (error) {
    return { unavailable: comparisonFailure(error) };
  }
}

/**
 * Bounds unexpected filesystem and metadata errors without leaking their contents.
 *
 * @param error - Failed comparison input or Git operation.
 * @returns Safe explanation of the comparison gap.
 */
function comparisonFailure(error: unknown): string {
  return error instanceof MemoryComparisonError
    ? error.message
    : "Repository source or wiki metadata could not be read safely for this comparison. Check the local files and retry.";
}
