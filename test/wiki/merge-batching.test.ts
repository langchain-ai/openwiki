import { describe, expect, test } from "vitest";
import { batchMergeCandidates } from "../../src/wiki/pipeline.ts";

// Merge candidates run concurrently within a batch, so two candidates
// sharing a page would otherwise have two agents writing the same file at
// once, silently losing whichever wrote second. batchMergeCandidates must
// guarantee no page repeats within a batch.

function candidate(pageA: string, pageB: string) {
  return { pageA, pageB, sharedEvidence: [] };
}

describe("batchMergeCandidates", () => {
  test("independent pairs all land in one batch", () => {
    const batches = batchMergeCandidates([
      candidate("/topics/a.md", "/topics/b.md"),
      candidate("/topics/c.md", "/topics/d.md"),
    ]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  test("pairs sharing a page are split across separate batches", () => {
    const batches = batchMergeCandidates([
      candidate("/topics/hub.md", "/topics/a.md"),
      candidate("/topics/hub.md", "/topics/b.md"),
      candidate("/topics/hub.md", "/topics/c.md"),
    ]);
    expect(batches).toHaveLength(3);
    for (const batch of batches) expect(batch).toHaveLength(1);
  });

  test("no page ever appears twice (as pageA or pageB) within a single batch", () => {
    const batches = batchMergeCandidates([
      candidate("/topics/hub.md", "/topics/a.md"),
      candidate("/topics/b.md", "/topics/hub.md"),
      candidate("/topics/c.md", "/topics/d.md"),
      candidate("/topics/a.md", "/topics/e.md"),
    ]);
    for (const batch of batches) {
      const pages = batch.flatMap((c) => [c.pageA, c.pageB]);
      expect(new Set(pages).size).toBe(pages.length);
    }
    // Every input candidate is still accounted for exactly once overall.
    expect(batches.flat()).toHaveLength(4);
  });

  test("an empty candidate list produces no batches", () => {
    expect(batchMergeCandidates([])).toEqual([]);
  });
});
