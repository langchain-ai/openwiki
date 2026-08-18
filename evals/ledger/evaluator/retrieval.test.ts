import { describe, expect, test } from "vitest";

import type { ArtifactSection } from "./documents.js";
import { SectionBm25Index, tokenizeForBm25 } from "./retrieval.js";

/**
 * Build an artifact-section fixture for retrieval tests.
 *
 * @param id - Stable section identifier.
 * @param searchableText - Text to index.
 * @param overrides - Optional field overrides.
 *
 * @returns A complete artifact section.
 */
function section(
  id: string,
  searchableText: string,
  overrides: Partial<ArtifactSection> = {},
): ArtifactSection {
  return {
    id,
    relativePath: `${id}.md`,
    headingPath: [],
    ordinal: 0,
    content: searchableText,
    searchableText,
    ...overrides,
  };
}

describe("tokenizeForBm25", () => {
  test("splits technical identifiers and retains Unicode letters and numbers", () => {
    expect(
      tokenizeForBm25(
        "RepositoryEvidenceResolver HTTPServer foo_bar/baz-qux.ts#Version2 café",
      ),
    ).toEqual([
      "repository",
      "evidence",
      "resolver",
      "http",
      "server",
      "foo",
      "bar",
      "baz",
      "qux",
      "ts",
      "version2",
      "café",
    ]);
  });

  test("discards punctuation and empty tokens without stemming or stop words", () => {
    expect(tokenizeForBm25("The retries... RETRIED?!")).toEqual([
      "the",
      "retries",
      "retried",
    ]);
  });
});

describe("SectionBm25Index", () => {
  test("ranks lexical matches before zero-score candidates", () => {
    const sections = [
      section("c", "Unrelated configuration"),
      section("b", "write file creates a new file"),
      section("a", "write file overwrites an existing file"),
    ];
    const index = new SectionBm25Index(sections);
    const results = index.search("write_file overwrite existing", 3);

    expect(results.map((result) => result.section.id)).toEqual(["a", "b", "c"]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(0);
    expect(results[2].score).toBe(0);
  });

  test("uses stable section-id ordering when scores tie, including empty queries", () => {
    const index = new SectionBm25Index([
      section("z", "same"),
      section("a", "same"),
      section("m", "different"),
    ]);

    expect(index.search("same", 3).map((result) => result.section.id)).toEqual([
      "a",
      "z",
      "m",
    ]);
    expect(index.search("", 2).map((result) => result.section.id)).toEqual([
      "a",
      "m",
    ]);
  });

  test("returns the default top eight and supports a smaller limit", () => {
    const sections = Array.from({ length: 10 }, (_, index) =>
      section(String(index).padStart(2, "0"), `section ${index}`),
    );
    const bm25 = new SectionBm25Index(sections);

    expect(bm25.search("absent")).toHaveLength(8);
    expect(bm25.search("absent", 3)).toHaveLength(3);
    expect(bm25.search("absent", 0)).toEqual([]);
    expect(bm25.search("absent", -1)).toEqual([]);
    expect(bm25.search("absent", Number.NaN)).toEqual([]);
  });

  test("does not mutate the source array or section objects", () => {
    const first = section("b", "beta");
    const second = section("a", "alpha");
    const sections = [first, second];
    const before = structuredClone(sections);
    const bm25 = new SectionBm25Index(sections);

    bm25.search("alpha", 2);

    expect(sections).toEqual(before);
    expect(sections[0]).toBe(first);
    expect(sections[1]).toBe(second);
  });

  test("returns a copied section list in stable ID order", () => {
    const index = new SectionBm25Index([
      section("z", "last"),
      section("a", "first"),
    ]);

    const first = index.sections();
    first.reverse();

    expect(index.sections().map((item) => item.id)).toEqual(["a", "z"]);
  });

  test("returns no results for an empty index", () => {
    expect(new SectionBm25Index([]).search("anything")).toEqual([]);
  });
});
