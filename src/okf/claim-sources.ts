import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { BackendProtocolV2 } from "deepagents";
import type { OpenWikiOutputMode } from "../agent/types.js";
import {
  formatRepositoryEvidenceResource,
  parseRepositoryEvidenceResource,
} from "../claims/evidence/repository/resource.js";
import { parseFrontmatterFields, setOkfSources } from "./frontmatter.js";
import { listWikiConceptPaths } from "./index-sync.js";

/**
 * Stable prefix identifying source entries owned by the Claims projection.
 */
const OPENWIKI_SOURCE_ID_PREFIX = "openwiki-source-";

/**
 * Page-local repository evidence resources keyed by virtual concept path.
 */
export type ClaimEvidenceResources = ReadonlyMap<string, readonly string[]>;

/**
 * Projects page-owned Claims evidence files into OKF `sources` front matter.
 *
 * Existing producer-authored source entries are retained. OpenWiki-owned
 * entries receive deterministic IDs derived from their resource, allowing a
 * later Claims reconciliation to replace or remove only its own projection.
 * Pages without Claims state are left untouched.
 *
 * @param backend - Active generated-wiki filesystem.
 * @param outputMode - Current wiki target.
 * @param resourcesByPage - Complete current evidence resources per Claims page.
 */
export async function synchronizeClaimSources(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
  resourcesByPage: ClaimEvidenceResources,
): Promise<void> {
  const concepts = new Set(await listWikiConceptPaths(backend, outputMode));
  const pages = [...resourcesByPage.keys()].sort((left, right) =>
    left.localeCompare(right),
  );

  for (const page of pages) {
    if (!concepts.has(page)) continue;
    const content = await readRequiredContent(backend, page);
    const currentSources = readSourceEntries(content);
    const nextSources = mergeClaimSources(
      currentSources,
      resourcesByPage.get(page) ?? [],
    );
    if (isDeepStrictEqual(currentSources, nextSources)) continue;

    const result = await backend.write(
      page,
      setOkfSources(content, nextSources),
    );
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
      id: openWikiSourceId(resource),
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
 * Identifies one source entry emitted by this Claims projection.
 */
function isOpenWikiSource(entry: Record<string, unknown>): boolean {
  return (
    typeof entry.id === "string" &&
    entry.id.startsWith(OPENWIKI_SOURCE_ID_PREFIX)
  );
}

/**
 * Derives a stable, portable source ID suitable for later footnote joins.
 */
function openWikiSourceId(resource: string): string {
  const digest = createHash("sha256")
    .update(resource)
    .digest("hex")
    .slice(0, 24);
  return `${OPENWIKI_SOURCE_ID_PREFIX}${digest}`;
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
