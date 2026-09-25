import { describe, expect, test } from "vitest";
import { createOpenWikiThreadId } from "../../src/agent/index.ts";

// createOpenWikiThreadId derives the checkpointer thread key. The directory
// component must be a stable hash of the resolved cwd (so repeated runs against
// the same wiki share a thread namespace) while the per-run suffix must be
// unique (so concurrent runs never collide on one checkpoint row).

const THREAD_ID_PATTERN = /^openwiki-([0-9a-f]{32})-(.+)$/u;

describe("createOpenWikiThreadId", () => {
  test("produces the openwiki-<32hex>-<runId> shape", () => {
    expect(createOpenWikiThreadId("/tmp/wiki-a")).toMatch(THREAD_ID_PATTERN);
  });

  test("the directory hash is stable for the same cwd but the run suffix is unique", () => {
    const first = createOpenWikiThreadId("/tmp/wiki-a");
    const second = createOpenWikiThreadId("/tmp/wiki-a");

    const firstDigest = first.match(THREAD_ID_PATTERN)?.[1];
    const secondDigest = second.match(THREAD_ID_PATTERN)?.[1];

    // Same directory -> identical hash segment...
    expect(firstDigest).toBe(secondDigest);
    // ...but the full IDs differ because the random run suffix rotates.
    expect(first).not.toBe(second);
  });

  test("distinct working directories hash to distinct thread namespaces", () => {
    const a =
      createOpenWikiThreadId("/tmp/wiki-a").match(THREAD_ID_PATTERN)?.[1];
    const b =
      createOpenWikiThreadId("/tmp/wiki-b").match(THREAD_ID_PATTERN)?.[1];

    expect(a).not.toBe(b);
  });

  test("relative and absolute forms of the same path share a hash", () => {
    // createThreadId resolves the path before hashing, so an already-absolute
    // path and its unresolved twin normalize to the same namespace.
    const resolved =
      createOpenWikiThreadId("/tmp/wiki-a/sub/..").match(
        THREAD_ID_PATTERN,
      )?.[1];
    const direct =
      createOpenWikiThreadId("/tmp/wiki-a").match(THREAD_ID_PATTERN)?.[1];

    expect(resolved).toBe(direct);
  });
});
