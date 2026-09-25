import { compareStrings } from "../core/order.js";
import type { ArtifactSection } from "./documents.js";

/**
 * Default number of ranked sections returned when a caller omits `topK`.
 */
const DEFAULT_TOP_K = 8;

/**
 * BM25 term-frequency saturation parameter.
 */
const K1 = 1.2;

/**
 * BM25 length-normalization parameter.
 */
const B = 0.75;

/**
 * A section paired with its BM25 relevance score.
 */
export interface RankedSection {
  /**
   * Artifact section being ranked.
   */
  section: ArtifactSection;

  /**
   * BM25 relevance score for the query.
   */
  score: number;
}

/**
 * Internal token statistics for one artifact section.
 */
interface IndexedSection {
  /**
   * Artifact section represented by these statistics.
   */
  section: ArtifactSection;

  /**
   * Number of occurrences of each token in the section.
   */
  frequencies: Map<string, number>;

  /**
   * Total number of indexed tokens in the section.
   */
  length: number;
}

/**
 * Deterministically tokenize source identifiers and prose for BM25. No stemming
 * or stop-word filtering is applied because technical identifiers carry meaning.
 */
export function tokenizeForBm25(value: string): string[] {
  return (
    value
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/**
 * Small benchmark-local BM25 index over immutable artifact sections. BM25 only
 * orders candidate evidence; later evaluation phases remain responsible for
 * exhaustively proving negative judgments.
 */
export class SectionBm25Index {
  private readonly indexed: IndexedSection[];
  private readonly documentFrequency: Map<string, number>;
  private readonly averageLength: number;

  constructor(sections: ArtifactSection[]) {
    this.documentFrequency = new Map<string, number>();
    this.indexed = [...sections].map((section) => {
      const tokens = tokenizeForBm25(section.searchableText);
      const frequencies = new Map<string, number>();

      for (const token of tokens) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }

      for (const token of frequencies.keys()) {
        this.documentFrequency.set(
          token,
          (this.documentFrequency.get(token) ?? 0) + 1,
        );
      }

      return { section, frequencies, length: tokens.length };
    });

    const totalLength = this.indexed.reduce(
      (sum, entry) => sum + entry.length,
      0,
    );
    this.averageLength =
      this.indexed.length === 0 ? 0 : totalLength / this.indexed.length;
  }

  /**
   * Return every indexed section in stable section-ID order. The returned array
   * is a copy and may be safely filtered or reordered by a caller.
   *
   * @returns All indexed sections in deterministic order.
   */
  sections(): ArtifactSection[] {
    return this.indexed
      .map((entry) => entry.section)
      .sort((a, b) => compareStrings(a.id, b.id));
  }

  /**
   * Rank sections for a query. Zero-score candidates are retained after all
   * positive matches so callers always receive up to `topK` sections.
   *
   * @param query - Fact statement or other lexical query.
   * @param topK - Maximum candidates to return.
   *
   * @returns Ranked candidates with deterministic ID tie-breaking.
   */
  search(query: string, topK = DEFAULT_TOP_K): RankedSection[] {
    if (!Number.isFinite(topK) || topK <= 0 || this.indexed.length === 0) {
      return [];
    }

    const limit = Math.floor(topK);
    const queryTerms = new Set(tokenizeForBm25(query));
    const documentCount = this.indexed.length;

    return this.indexed
      .map(({ section, frequencies, length }): RankedSection => {
        let score = 0;

        for (const term of queryTerms) {
          const frequency = frequencies.get(term) ?? 0;

          if (frequency === 0) {
            continue;
          }

          const df = this.documentFrequency.get(term) ?? 0;
          const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
          const lengthRatio =
            this.averageLength === 0 ? 0 : length / this.averageLength;
          const denominator = frequency + K1 * (1 - B + B * lengthRatio);

          score += idf * ((frequency * (K1 + 1)) / denominator);
        }

        return { section, score };
      })
      .sort(
        (a, b) =>
          b.score - a.score || compareStrings(a.section.id, b.section.id),
      )
      .slice(0, limit);
  }
}
