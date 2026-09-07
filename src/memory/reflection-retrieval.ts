import { OpenWikiIgnore } from "../agent/openwiki-ignore.js";
import { parseRepositoryEvidenceResource } from "../claims/evidence/repository/resource.js";
import {
  connectResources,
  loadConnections,
  type KnowledgeConnections,
  type KnowledgeScope,
} from "./changes.js";
import { MemoryComparisonError, MemoryGit } from "./git.js";
import {
  REFLECTIONS_DIRECTORY,
  ReflectionSchema,
  serializeReflection,
  type Reflection,
  type ReflectionLayers,
  type WikiClaimReflection,
  type WikiPageReflection,
  type WikiSectionReflection,
} from "./reflection-types.js";
import { ReflectionStore } from "./reflections.js";
import type { MemoryChanges, MemoryContext } from "./types.js";

/**
 * Returns every locally available finding, including discoveries without known wiki links.
 *
 * @param root - Absolute repository root.
 * @param pages - Complete factual wiki page directory.
 * @returns Pending findings connected to wiki pages and classified when history permits.
 */
export function orientReflections(
  root: string,
  pages: readonly string[],
): Promise<ReflectionLayers<WikiPageReflection>> {
  return reflectionsForScope(
    root,
    { pages, repositoryWide: true },
    (reflection, related) => ({
      id: reflection.id,
      finding: reflection.finding,
      relatedPages: related.pages,
    }),
  );
}

/**
 * Returns discoveries related to the requested page's sections.
 *
 * @param root - Absolute repository root.
 * @param page - Wiki-relative page returned by outline.
 * @returns Findings connected through the page's claim evidence and prose bindings.
 */
export function outlineReflections(
  root: string,
  page: string,
): Promise<ReflectionLayers<WikiSectionReflection>> {
  return reflectionsForScope(
    root,
    { pages: [page], repositoryWide: false },
    (reflection, related) => ({
      id: reflection.id,
      finding: reflection.finding,
      relatedSectionIds: related.sectionIds,
    }),
  );
}

/**
 * Returns discoveries and evidence relevant to the sections actually included in a read.
 *
 * @param root - Absolute repository root.
 * @param page - Wiki-relative page returned by read.
 * @param sectionIds - Expanded section selection, including descendants.
 * @returns Related discoveries with supporting resource URIs and claim identities.
 */
export function readReflections(
  root: string,
  page: string,
  sectionIds: readonly string[],
): Promise<ReflectionLayers<WikiClaimReflection>> {
  return reflectionsForScope(
    root,
    { pages: [page], repositoryWide: false, sectionIds: new Set(sectionIds) },
    (reflection, related) => ({
      id: reflection.id,
      finding: reflection.finding,
      evidence: reflection.evidence.map(({ resource }) => ({ resource })),
      relatedClaimIds: related.claimIds,
    }),
  );
}

/**
 * Combines independently evaluated source and reflection context without losing either.
 *
 * @param changes - Source comparison for this tool's scope.
 * @param reflections - Independently loaded and classified pending findings.
 * @returns The agreed memory layers and an exceptional unclassified fallback when needed.
 */
export async function combineMemory<TChange, TReflection>(
  changes: Promise<MemoryChanges<TChange>>,
  reflections: Promise<ReflectionLayers<TReflection>>,
): Promise<MemoryContext<TChange, TReflection>> {
  const [source, findings] = await Promise.all([changes, reflections]);
  return {
    shortTerm: { ...source.shortTerm, reflections: findings.shortTerm },
    working: { ...source.working, reflections: findings.working },
    ...(findings.unclassifiedReflections
      ? { unclassifiedReflections: findings.unclassifiedReflections }
      : {}),
  };
}

/**
 * Reads local findings before attempting Git classification or wiki relationship lookup.
 *
 * @param root - Absolute repository root.
 * @param scope - Requested wiki knowledge.
 * @param project - Compact tool-specific finding projection.
 * @returns Each readable finding once, with explicit feedback for unknown origin or inventory gaps.
 */
async function reflectionsForScope<T>(
  root: string,
  scope: KnowledgeScope,
  project: (reflection: Reflection, related: KnowledgeConnections) => T,
): Promise<ReflectionLayers<T>> {
  const inventory = await new ReflectionStore(root).list();
  const result: ReflectionLayers<T> = { shortTerm: [], working: [] };
  const unclassified: T[] = [];
  const failures = new Set(
    inventory.unavailable ? [inventory.unavailable] : [],
  );
  if (!inventory.reflections.length) {
    if (inventory.unavailable)
      result.unclassifiedReflections = {
        unavailable: inventory.unavailable,
        reflections: [],
      };
    return result;
  }
  try {
    const connections = await loadConnections(root, scope);
    const relevant = inventory.reflections
      .map((reflection) => ({
        reflection,
        related: connectResources(
          reflection.evidence.map(
            ({ resource }) => parseRepositoryEvidenceResource(resource).path,
          ),
          connections,
        ),
      }))
      .filter(
        ({ related }) => scope.repositoryWide || related.pages.length > 0,
      );
    if (relevant.length) {
      const git = new MemoryGit(root, new OpenWikiIgnore([]));
      let main: string | undefined;
      try {
        main = await git.main();
      } catch (error) {
        failures.add(classificationFailure(error));
      }
      for (const { reflection, related } of relevant) {
        const entry = project(reflection, related);
        if (!main) {
          unclassified.push(entry);
          continue;
        }
        try {
          const merged = await appearedOnMain(git, main, reflection);
          (merged ? result.shortTerm : result.working).push(entry);
        } catch (error) {
          unclassified.push(entry);
          failures.add(classificationFailure(error));
        }
      }
    }
  } catch (error) {
    // Retain readable records even if their scope cannot be established from sidecars.
    unclassified.push(
      ...inventory.reflections.map((reflection) =>
        project(reflection, { pages: [], sectionIds: [], claimIds: [] }),
      ),
    );
    failures.add(classificationFailure(error));
  }
  if (failures.size)
    result.unclassifiedReflections = {
      unavailable: [...failures].join(" "),
      reflections: unclassified,
    };
  return result;
}

/**
 * Proves whether this exact finding has appeared in the locally known main history.
 *
 * The current main snapshot is sufficient proof, including in shallow clones.
 * Historical lookup also recognizes records later removed from main while an
 * older checkout still has them. Absence across a shallow boundary is unknown.
 *
 * @param git - Read-only Git adapter.
 * @param main - Captured default-branch commit.
 * @param reflection - Complete immutable local record.
 * @returns True for a record shared on main, false for a record absent from complete history.
 */
async function appearedOnMain(
  git: MemoryGit,
  main: string,
  reflection: Reflection,
): Promise<boolean> {
  const file = `${REFLECTIONS_DIRECTORY}/${reflection.id}.json`;
  if (matchesReflection(await git.fileAt(main, file), reflection)) return true;
  for (const commit of await git.fileHistory(main, file)) {
    if (
      commit !== main &&
      matchesReflection(await git.fileAt(commit, file), reflection)
    )
      return true;
  }
  if (await git.isShallow())
    throw new MemoryComparisonError(
      "Local Git history is shallow, so this reflection's main-versus-branch origin cannot be established. Fetch the required history and retry.",
    );
  return false;
}

/**
 * Compares validated records while ignoring JSON formatting and object-key order.
 *
 * @param content - Committed file content, or null for an absent or non-regular path.
 * @param reflection - Complete local record.
 * @returns Whether the committed record carries this finding and captured evidence.
 */
function matchesReflection(
  content: string | null,
  reflection: Reflection,
): boolean {
  if (content === null) return false;
  try {
    return (
      serializeReflection(
        ReflectionSchema.parse(JSON.parse(content) as unknown),
      ) === serializeReflection(reflection)
    );
  } catch {
    return false;
  }
}

/**
 * Bounds classification and connection failures without leaking source or sidecar contents.
 *
 * @param error - Unknown Git or metadata lookup failure.
 * @returns A clear explanation that readable pending findings remain available.
 */
function classificationFailure(error: unknown): string {
  return error instanceof MemoryComparisonError
    ? error.message
    : "Some reflection origins or wiki connections could not be established from local history and metadata. The readable findings are retained without classification.";
}
