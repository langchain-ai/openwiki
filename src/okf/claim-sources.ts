import { isDeepStrictEqual } from "node:util";
import type { BackendProtocolV2 } from "deepagents";
import type { OpenWikiOutputMode } from "../agent/types.js";
import {
  formatRepositoryEvidenceResource,
  parseRepositoryEvidenceResource,
} from "../claims/evidence/repository/resource.js";
import {
  parseFrontmatterFields,
  repairOkfFrontmatter,
  setOkfSources,
} from "./frontmatter.js";
import { listWikiConceptPaths } from "./index-sync.js";

/**
 * Legacy prefix earlier OpenWiki versions wrote on `sources[].id` to mark
 * ownership. Recognized on read only, so wikis generated before this change
 * still get their stale entries replaced instead of retained forever.
 */
const LEGACY_OPENWIKI_SOURCE_ID_PREFIX = "openwiki-source-";

/**
 * Actor-convention prefix (OKF section 7) identifying source entries this
 * Claims projection owns, independent of which OpenWiki version wrote them.
 */
const OPENWIKI_SOURCE_AUTHOR_PREFIX = "openwiki/";

/**
 * Page-local repository evidence resources keyed by virtual concept path.
 */
export type ClaimEvidenceResources = ReadonlyMap<string, readonly string[]>;

/**
 * Projects page-owned Claims evidence files into OKF `sources` front matter.
 *
 * Existing producer-authored source entries are retained. OpenWiki-owned
 * entries are tagged with `author: <producerActor>` (OKF section 7's actor
 * convention), which lets a later Claims reconciliation replace or remove
 * only its own projection. They omit `id`: per OKF section 5.1, `id` "SHOULD
 * be present when the body cites the source", and no claim currently cites
 * an individual source by footnote, so writing one would only add opaque
 * per-entry noise a reader or agent has to read past for no benefit. Pages
 * without Claims state are left untouched.
 *
 * @param backend - Active generated-wiki filesystem.
 * @param outputMode - Current wiki target.
 * @param resourcesByPage - Complete current evidence resources per Claims page.
 * @param producerActor - Actor tag stamped on entries this call projects.
 */
export async function synchronizeClaimSources(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
  resourcesByPage: ClaimEvidenceResources,
  producerActor: string,
): Promise<void> {
  const concepts = new Set(await listWikiConceptPaths(backend, outputMode));
  const pages = [...resourcesByPage.keys()].sort((left, right) =>
    left.localeCompare(right),
  );

  for (const page of pages) {
    if (!concepts.has(page)) continue;
    const content = await readRequiredContent(backend, page);
    const repaired = repairOkfFrontmatter(content, page).content;
    const currentSources = readSourceEntries(repaired);
    const nextSources = mergeClaimSources(
      currentSources,
      resourcesByPage.get(page) ?? [],
      producerActor,
    );
    const projected = isDeepStrictEqual(currentSources, nextSources)
      ? repaired
      : repairOkfFrontmatter(setOkfSources(repaired, nextSources), page)
          .content;
    if (projected === content) continue;

    const result = await backend.write(page, projected);
    if (result.error) {
      throw new Error(
        `Unable to synchronize OKF sources for ${page}: ${result.error}`,
      );
    }
  }
}

/**
 * Merges code-owned Claims resources with independently authored OKF sources.
 */
function mergeClaimSources(
  current: readonly Record<string, unknown>[],
  resources: readonly string[],
  producerActor: string,
): Record<string, unknown>[] {
  const retained = current.filter((entry) => !isOpenWikiSource(entry));
  const retainedResources = new Set(
    retained.flatMap((entry) =>
      typeof entry.resource === "string" ? [entry.resource] : [],
    ),
  );
  const projected = [...new Set(resources.map(toWholeFileRepositoryResource))]
    .sort((left, right) => left.localeCompare(right))
    .filter((resource) => !retainedResources.has(resource))
    .map((resource) => ({
      author: producerActor,
      resource,
    }));
  return [...retained, ...projected];
}

/**
 * Keeps precise line ranges in Claims state while exposing page-level source
 * files through OKF provenance.
 */
function toWholeFileRepositoryResource(resource: string): string {
  const parsed = parseRepositoryEvidenceResource(resource);
  return formatRepositoryEvidenceResource({ path: parsed.path });
}

/**
 * Reads valid source mappings while treating a malformed field as empty.
 *
 * The OKF validator separately reports malformed producer input. Projection
 * repairs that field rather than reproducing entries that cannot satisfy the
 * required `resource` contract.
 */
function readSourceEntries(content: string): Record<string, unknown>[] {
  const value = parseFrontmatterFields(content)?.sources;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) &&
      typeof entry.resource === "string" &&
      entry.resource.trim() !== "",
  );
}

/**
 * Identifies one source entry emitted by this Claims projection, including
 * entries an earlier OpenWiki version tagged via the legacy `id` prefix.
 */
function isOpenWikiSource(entry: Record<string, unknown>): boolean {
  if (
    typeof entry.author === "string" &&
    entry.author.startsWith(OPENWIKI_SOURCE_AUTHOR_PREFIX)
  ) {
    return true;
  }
  return (
    typeof entry.id === "string" &&
    entry.id.startsWith(LEGACY_OPENWIKI_SOURCE_ID_PREFIX)
  );
}

/**
 * Reads one required concept as UTF-8-compatible Markdown.
 */
async function readRequiredContent(
  backend: BackendProtocolV2,
  page: string,
): Promise<string> {
  const read = await backend.readRaw(page);
  const content = read.data?.content;
  if (read.error || content === undefined || content instanceof Uint8Array) {
    throw new Error(
      `Unable to read ${page} while synchronizing OKF sources: ${read.error ?? "no text data"}`,
    );
  }
  return Array.isArray(content) ? content.join("\n") : content;
}

/**
 * Narrows an unknown value to a non-array mapping.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
