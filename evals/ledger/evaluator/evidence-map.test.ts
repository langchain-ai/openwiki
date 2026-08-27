import { describe, expect, test } from "vitest";

import type { SemanticEvidenceMap } from "../core/types.js";
import type { ArtifactSection } from "./documents.js";
import { SemanticEvidenceRouter } from "./evidence-map.js";

function source(id: string, relativePath: string): ArtifactSection {
  return {
    id,
    relativePath,
    headingPath: [],
    ordinal: 0,
    content: `raw source from ${relativePath}`,
    searchableText: relativePath,
  };
}

const map: SemanticEvidenceMap = {
  entries: [
    {
      id: "queue-ordering",
      concept:
        "task queue ordering FIFO LIFO oldest newest insertion and removal behavior",
      evidence: ["src/queue.ts#dequeue", "src/worker.ts#runWorker"],
    },
    {
      id: "retry-policy",
      concept: "retry attempts timing delay and exponential backoff behavior",
      evidence: ["src/retry.ts#withRetry"],
    },
    {
      id: "tests",
      concept: "tests assertions imports and test coverage",
      evidence: ["test/**/*.ts"],
    },
  ],
};

describe("SemanticEvidenceRouter", () => {
  test("matches prose to concepts, then resolves raw owning files", () => {
    const router = new SemanticEvidenceRouter(map);
    const match = router.match("The oldest task leaves the queue first.");
    const resolved = router.resolve(match, [
      source("queue-0", "src/queue.ts"),
      source("worker-0", "src/worker.ts"),
      source("retry-0", "src/retry.ts"),
    ]);

    expect(match.entryIds[0]).toBe("queue-ordering");
    expect(resolved.sourceRefs).toEqual(["src/queue.ts", "src/worker.ts"]);
    expect(resolved.sections.map((section) => section.content)).toEqual([
      "raw source from src/queue.ts",
      "raw source from src/worker.ts",
    ]);
  });

  test("resolves path globs and ignores selectors absent at a checkpoint", () => {
    const router = new SemanticEvidenceRouter(map);
    const match = router.match("The tests import only Priority.");
    const resolved = router.resolve(match, [
      source("test-0", "test/queue.test.ts"),
      source("src-0", "src/task.ts"),
    ]);

    expect(match.entryIds).toContain("tests");
    expect(resolved.sourceRefs).toEqual(["test/queue.test.ts"]);
  });

  test("returns no route when a claim shares no concept vocabulary", () => {
    const router = new SemanticEvidenceRouter(map);

    expect(router.match("Maintainers prefer purple branding.")).toEqual({
      entryIds: [],
      selectors: [],
    });
  });
});
