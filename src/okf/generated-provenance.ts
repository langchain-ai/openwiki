import { createHash } from "node:crypto";
import type { BackendProtocolV2 } from "deepagents";
import type { OpenWikiOutputMode } from "../agent/types.js";
import {
  parseFrontmatterFields,
  removeFrontmatterField,
  setGeneratedEvent,
  splitFrontmatter,
} from "./frontmatter.js";
import { listWikiConceptPaths } from "./index-sync.js";

/**
 * Persisted producer event captured before an agent run.
 */
interface GeneratedEvent {
  /**
   * Producer actor responsible for the prior body change.
   */
  by: string;

  /**
   * Producer-recorded time of the prior body change.
   *
   * @default undefined - the prior event did not record a time.
   */
  at?: string;
}

/**
 * Minimal pre-run state needed to finalize one concept's provenance.
 */
interface ConceptSnapshot {
  /**
   * Hash of the exact Markdown body, excluding front matter.
   */
  bodyHash: string;

  /**
   * Valid producer event present before the run.
   *
   * @default undefined - the page had no valid generated event.
   */
  generated?: GeneratedEvent;
}

/**
 * Run-scoped provenance baseline keyed by virtual concept path.
 */
export type GeneratedProvenanceSnapshot = ReadonlyMap<string, ConceptSnapshot>;

/**
 * JSON-safe representation of one pre-run generated-page baseline.
 */
export interface PersistedGeneratedProvenanceEntry {
  /**
   * Canonical virtual path of the generated Markdown page.
   */
  page: string;

  /**
   * Hash of the page body before this run began authoring.
   */
  bodyHash: string;

  /**
   * Existing generated-provenance metadata, when the page had it.
   */
  generated?: {
    /**
     * Producer recorded in the page's generated metadata.
     */
    by: string;

    /**
     * Generation timestamp recorded by the prior successful run.
     */
    at?: string;
  };
}

/**
 * Deterministically ordered persisted provenance baseline.
 */
export type PersistedGeneratedProvenanceSnapshot =
  PersistedGeneratedProvenanceEntry[];

/**
 * Serializes the exact pre-authoring baseline without changing its meaning.
 */
export function serializeGeneratedProvenance(
  snapshot: GeneratedProvenanceSnapshot,
): PersistedGeneratedProvenanceSnapshot {
  return [...snapshot.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([page, value]) => ({
      page,
      bodyHash: value.bodyHash,
      ...(value.generated
        ? {
            generated: {
              by: value.generated.by,
              ...(value.generated.at ? { at: value.generated.at } : {}),
            },
          }
        : {}),
    }));
}

/**
 * Recreates the in-memory provenance baseline after process restart.
 */
export function deserializeGeneratedProvenance(
  persisted: PersistedGeneratedProvenanceSnapshot,
): GeneratedProvenanceSnapshot {
  return new Map(
    persisted.map(({ page, bodyHash, generated }) => [
      page,
      {
        bodyHash,
        ...(generated ? { generated: { ...generated } } : {}),
      },
    ]),
  );
}

/**
 * Captures finalization inputs for every concept present before the agent runs.
 * Only hashes and the prior producer event are retained, keeping the snapshot
 * bounded without creating temporary files beside generated documentation.
 *
 * @param backend - Active wiki filesystem abstraction.
 * @param outputMode - Current wiki target.
 * @returns Pre-run concept state keyed by virtual page path.
 */
export async function snapshotGeneratedProvenance(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
): Promise<GeneratedProvenanceSnapshot> {
  const snapshots = new Map<string, ConceptSnapshot>();
  for (const page of await listWikiConceptPaths(backend, outputMode)) {
    const content = await readRequiredContent(backend, page);
    snapshots.set(page, {
      bodyHash: hashConceptBody(content),
      generated: readGeneratedEvent(content),
    });
  }
  return snapshots;
}

/**
 * Reconciles producer provenance against the final post-processed wiki.
 * New pages and pages whose bodies changed in any way receive the run stamp.
 * An unchanged body receives its prior stamp back when an agent rewrite removed
 * or altered it; pages that were previously unstamped remain unstamped.
 *
 * @param backend - Active wiki filesystem abstraction.
 * @param outputMode - Current wiki target.
 * @param initialConcepts - Pre-run state keyed by virtual page path.
 * @param now - Shared run timestamp used for new generated events.
 * @param producerActor - Producer responsible for body changes in this run.
 */
export async function finalizeGeneratedProvenance(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
  initialConcepts: GeneratedProvenanceSnapshot,
  now: string,
  producerActor: string,
): Promise<void> {
  if (producerActor.trim().length === 0) {
    throw new Error(
      "Generated provenance requires a non-empty producer actor.",
    );
  }

  for (const page of await listWikiConceptPaths(backend, outputMode)) {
    const content = await readRequiredContent(backend, page);
    const initial = initialConcepts.get(page);
    const bodyChanged =
      initial === undefined || initial.bodyHash !== hashConceptBody(content);
    const reconciled = bodyChanged
      ? removeFrontmatterField(
          setGeneratedEvent(content, producerActor, now),
          "timestamp",
        )
      : restoreGeneratedEvent(content, initial.generated);

    if (reconciled !== content) {
      const result = await backend.write(page, reconciled);
      if (result.error) {
        throw new Error(
          `Unable to finalize generated provenance for ${page}: ${result.error}`,
        );
      }
    }
  }
}

/**
 * Reads one required concept as UTF-8-compatible text.
 *
 * @param backend - Active wiki filesystem abstraction.
 * @param filePath - Virtual concept path to read.
 * @returns Complete persisted concept content.
 */
async function readRequiredContent(
  backend: BackendProtocolV2,
  filePath: string,
): Promise<string> {
  const read = await backend.readRaw(filePath);
  const content = read.data?.content;
  if (read.error || content === undefined || content instanceof Uint8Array) {
    throw new Error(
      `Unable to read concept ${filePath}: ${read.error ?? "not text"}`,
    );
  }
  return Array.isArray(content) ? content.join("\n") : content;
}

/**
 * Hashes the exact Markdown body while excluding front matter. Whitespace is
 * retained so any body change advances the generated event.
 *
 * @param content - Complete concept document.
 * @returns Stable SHA-256 body fingerprint.
 */
function hashConceptBody(content: string): string {
  const body = splitFrontmatter(content).body;
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Reads a valid producer event from a page's front matter.
 *
 * @param content - Complete concept document.
 * @returns Parsed producer event, or `undefined` when absent or invalid.
 */
function readGeneratedEvent(content: string): GeneratedEvent | undefined {
  const value = parseFrontmatterFields(content)?.generated;
  if (
    !isRecord(value) ||
    typeof value.by !== "string" ||
    value.by.trim().length === 0 ||
    (value.at !== undefined &&
      (typeof value.at !== "string" || value.at.trim().length === 0))
  ) {
    return undefined;
  }
  return {
    by: value.by,
    ...(typeof value.at === "string" ? { at: value.at } : {}),
  };
}

/**
 * Restores the pre-run producer event without advancing its timestamp.
 *
 * @param content - Final concept document.
 * @param generated - Valid pre-run producer event, when one existed.
 * @returns Content with the code-owned field restored or removed.
 */
function restoreGeneratedEvent(
  content: string,
  generated?: GeneratedEvent,
): string {
  return generated
    ? setGeneratedEvent(content, generated.by, generated.at)
    : removeFrontmatterField(content, "generated");
}

/**
 * Narrows an unknown value to a non-array object record.
 *
 * @param value - Unknown candidate value.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
