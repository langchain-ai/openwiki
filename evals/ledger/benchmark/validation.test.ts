import { describe, expect, test } from "vitest";

import type {
  LedgerBenchmark,
  LedgerCheckpoint,
  SemanticEvidenceMapEntry,
} from "../core/types.js";
import { BenchmarkValidationError } from "../core/errors.js";
import { validateBenchmark } from "./validation.js";

/**
 * A minimal two-checkpoint benchmark. Source is the ground truth now, so a
 * benchmark requires a trace of named checkpoints and may add evaluator-only
 * routing metadata; each test starts from this valid minimal shape and mutates
 * it into the specific violation it exercises.
 *
 * @returns A structurally valid benchmark.
 */
function valid(): LedgerBenchmark {
  return {
    name: "valid",
    description: "validation fixture",
    difficulty: "easy",
    sourceRepoPath: "/nonexistent",
    trace: {
      checkpoints: [
        { id: "T0", commit: "aaaaaaa" },
        { id: "T1", commit: "bbbbbbb" },
      ],
    },
  };
}

/**
 * Assert that validating `benchmark` fails as a `BenchmarkValidationError` whose
 * message matches `messagePattern`. Centralizes the throw-type-and-message
 * assertion every rejection case shares, and in doing so pins down that malformed
 * input surfaces as the custom validation error rather than a raw `TypeError`.
 *
 * @param benchmark - The (deliberately invalid) benchmark to validate.
 * @param messagePattern - Pattern the thrown message must match.
 */
function expectRejected(
  benchmark: LedgerBenchmark,
  messagePattern: RegExp,
): void {
  expect(() => validateBenchmark(benchmark)).toThrow(BenchmarkValidationError);
  expect(() => validateBenchmark(benchmark)).toThrow(messagePattern);
}

describe("validateBenchmark", () => {
  test("accepts a well-formed trace", () => {
    expect(() => validateBenchmark(valid())).not.toThrow();
  });

  test("accepts a full 40-character lowercase-hex commit SHA", () => {
    const benchmark = valid();
    benchmark.trace.checkpoints[0].commit = "a".repeat(40);

    expect(() => validateBenchmark(benchmark)).not.toThrow();
  });
});

describe("validateBenchmark trace rules", () => {
  test("rejects an empty checkpoint list", () => {
    const benchmark = valid();
    benchmark.trace.checkpoints = [];

    expectRejected(benchmark, /trace\.checkpoints must be a non-empty array/);
  });

  test("rejects a checkpoint with an empty id", () => {
    const benchmark = valid();
    benchmark.trace.checkpoints[0].id = "";

    expectRejected(benchmark, /position 0 has an invalid id/);
  });

  test.each([
    ["parent traversal", "../outside"],
    ["current-directory segment", "."],
    ["parent-directory segment", ".."],
    ["path separator", "T0/nested"],
    ["over 64 characters", "a".repeat(65)],
  ])("rejects a checkpoint id containing %s", (_label, checkpointId) => {
    const benchmark = valid();
    benchmark.trace.checkpoints[0].id = checkpointId;

    expectRejected(benchmark, /position 0 has an invalid id/);
  });

  test("rejects duplicate checkpoint ids", () => {
    const benchmark = valid();
    benchmark.trace.checkpoints[1].id = "T0";

    expectRejected(benchmark, /Duplicate checkpoint id "T0"/);
  });

  test("rejects a null checkpoint entry as a validation error, not a crash", () => {
    const benchmark = valid();
    benchmark.trace.checkpoints[0] = null as unknown as LedgerCheckpoint;

    expectRejected(benchmark, /Checkpoint at position 0 is not an object/);
  });
});

describe("validateBenchmark evidence-map rules", () => {
  test("accepts evaluator-only concepts with paths, symbols, and globs", () => {
    const benchmark = valid();
    benchmark.evidenceMap = {
      entries: [
        {
          id: "queue-ordering",
          concept: "task queue insertion, ordering, and removal behavior",
          evidence: ["src/queue.ts#dequeue", "test/**/*.ts"],
        },
      ],
    };

    expect(() => validateBenchmark(benchmark)).not.toThrow();
  });

  test("rejects duplicate route ids", () => {
    const benchmark = valid();
    benchmark.evidenceMap = {
      entries: [
        { id: "queue", concept: "queue behavior", evidence: ["src/a.ts"] },
        { id: "queue", concept: "worker behavior", evidence: ["src/b.ts"] },
      ],
    };

    expectRejected(benchmark, /Duplicate evidence-map entry id "queue"/);
  });

  test("rejects expected answers embedded as extra entry fields", () => {
    const benchmark = valid();
    benchmark.evidenceMap = {
      entries: [
        {
          id: "queue",
          concept: "queue behavior",
          evidence: ["src/queue.ts"],
          expected: "FIFO",
        } as unknown as SemanticEvidenceMapEntry,
      ],
    };

    expectRejected(benchmark, /unsupported field "expected"/);
  });

  test("rejects absolute and parent-traversing selectors", () => {
    for (const selector of ["/src/queue.ts", "../src/queue.ts"]) {
      const benchmark = valid();
      benchmark.evidenceMap = {
        entries: [
          { id: "queue", concept: "queue behavior", evidence: [selector] },
        ],
      };

      expectRejected(benchmark, /invalid selector/);
    }
  });
});

describe("validateBenchmark commit SHA allowlist", () => {
  // COMMIT_PATTERN guards what reaches Git via execFile, so a malformed or
  // adversarial SHA must be rejected before any replay. Each of these fails the
  // /^[0-9a-f]{7,40}$/ allowlist for a distinct reason.
  const badCommits: Array<[label: string, commit: string]> = [
    ["non-hex characters", "zzzzzzz"],
    ["too short", "abc123"],
    ["too long", "a".repeat(41)],
    ["uppercase hex", "ABCDEF0"],
    ["embedded whitespace", "aaa aaa"],
    ["a smuggled flag", "--upload-pack=touch"],
    ["empty", ""],
  ];

  test.each(badCommits)("rejects a commit with %s", (_label, commit) => {
    const benchmark = valid();
    benchmark.trace.checkpoints[0].commit = commit;

    expectRejected(benchmark, /Checkpoint "T0" has an invalid commit SHA/);
  });
});
