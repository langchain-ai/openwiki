import path from "node:path";

import type {
  SemanticEvidenceMap,
  SemanticEvidenceMapEntry,
} from "../core/types.js";
import { compareStrings } from "../core/order.js";
import type { ArtifactSection } from "./documents.js";
import { SectionBm25Index } from "./retrieval.js";

/** Maximum topic routes attached to one claim. */
const MAX_MATCHED_ENTRIES = 3;

/** One evidence-map match before its selectors are resolved at a checkpoint. */
export interface EvidenceMapMatch {
  /** Matched route IDs in relevance order. */
  entryIds: string[];

  /** Union of selectors declared by the matched routes. */
  selectors: string[];
}

/** Checkpoint-specific resolution of a semantic evidence-map match. */
export interface ResolvedEvidenceMapMatch {
  /** Evidence excerpts owned by files selected through the map. */
  sections: ArtifactSection[];

  /** Human-readable source files represented by those excerpts. */
  sourceRefs: string[];
}

/** Split an optional symbol suffix from its owning path or path glob. */
function selectorPath(selector: string): string {
  return selector.split("#", 1)[0];
}

/** Whether one source path is selected by an exact path or path glob. */
function selectorMatchesSource(selector: string, sourceRef: string): boolean {
  const pattern = selectorPath(selector);
  return pattern === sourceRef || path.posix.matchesGlob(sourceRef, pattern);
}

/**
 * Benchmark-local semantic router. BM25 operates only over authored
 * natural-language topic descriptions; it never attempts to understand source
 * syntax. Matched routes then resolve deterministically to raw source excerpts.
 */
export class SemanticEvidenceRouter {
  private readonly entries: Map<string, SemanticEvidenceMapEntry>;

  private readonly index: SectionBm25Index | undefined;

  constructor(evidenceMap: SemanticEvidenceMap | undefined) {
    const entries = [...(evidenceMap?.entries ?? [])].sort((a, b) =>
      compareStrings(a.id, b.id),
    );
    this.entries = new Map(entries.map((entry) => [entry.id, entry]));
    this.index =
      entries.length === 0
        ? undefined
        : new SectionBm25Index(
            entries.map((entry): ArtifactSection => ({
              id: entry.id,
              relativePath: "",
              headingPath: [],
              ordinal: 0,
              content: entry.concept,
              searchableText: entry.concept,
            })),
          );
  }

  /**
   * Match a wiki claim to up to three positively scoring topic routes. A claim
   * with no shared terms produces no route and retains normal source fallback.
   */
  match(query: string): EvidenceMapMatch {
    if (this.index === undefined) {
      return { entryIds: [], selectors: [] };
    }

    const matchedEntries = this.index
      .search(query, this.entries.size)
      .filter((candidate) => candidate.score > 0)
      .slice(0, MAX_MATCHED_ENTRIES)
      .map((candidate) => this.entries.get(candidate.section.id)!)
      .filter(
        (entry): entry is SemanticEvidenceMapEntry => entry !== undefined,
      );
    const selectors = new Set<string>();
    for (const entry of matchedEntries) {
      entry.evidence.forEach((selector) => selectors.add(selector));
    }

    return {
      entryIds: matchedEntries.map((entry) => entry.id),
      selectors: [...selectors].sort(compareStrings),
    };
  }

  /**
   * Resolve matched selectors against one current or historical evidence set.
   * `path#symbol` selects the complete owning file in V1 so surrounding code is
   * always visible to the grounding judge.
   */
  resolve(
    match: EvidenceMapMatch,
    sections: ArtifactSection[],
  ): ResolvedEvidenceMapMatch {
    const selected = sections
      .filter(
        (section) =>
          section.relativePath !== "git tracked files" &&
          match.selectors.some((selector) =>
            selectorMatchesSource(selector, section.relativePath),
          ),
      )
      .sort((a, b) => compareStrings(a.id, b.id));

    return {
      sections: selected,
      sourceRefs: [
        ...new Set(selected.map((section) => section.relativePath)),
      ].sort(compareStrings),
    };
  }
}
