import { describe, expect, test } from "vitest";

import type {
  LedgerBenchmark,
  LedgerCheckpoint,
  TruthFact,
} from "../core/types.js";
import type { TruthFactVersion } from "../core/types.js";
import { BenchmarkValidationError } from "../core/errors.js";
import { validateBenchmark } from "./validation.js";

/**
 * A minimal two-checkpoint benchmark in which every checkpoint has an active
 * fact. Each test starts from this valid shape and mutates it into the specific
 * violation it exercises.
 */
function valid(): LedgerBenchmark {
  return {
    name: "valid",
    description: "validation fixture",
    sourceRepoPath: "/nonexistent",
    trace: {
      checkpoints: [
        { id: "T0", commit: "aaaaaaa" },
        { id: "T1", commit: "bbbbbbb" },
      ],
    },
    truthPackage: {
      requirements: [
        {
          id: "spanning",
          versions: [{ statement: "true throughout", fromCheckpoint: "T0" }],
        },
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
  test("accepts a benchmark whose every checkpoint has an active fact", () => {
    expect(() => validateBenchmark(valid())).not.toThrow();
  });

  test("accepts a full 40-character lowercase-hex commit SHA", () => {
    const benchmark = valid();
    benchmark.trace.checkpoints[0].commit = "a".repeat(40);

    expect(() => validateBenchmark(benchmark)).not.toThrow();
  });

  test("rejects a checkpoint left with no active facts", () => {
    const benchmark = valid();
    // Retire the only fact at T1 (half-open [T0, T1)), emptying T1's active set.
    benchmark.truthPackage.requirements[0].versions[0].untilCheckpoint = "T1";

    expectRejected(benchmark, /T1.*no active coverage facts/);
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

    expectRejected(benchmark, /position 0 has an empty id/);
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

describe("validateBenchmark Truth Package rules", () => {
  test("rejects an empty facts list", () => {
    const benchmark = valid();
    benchmark.truthPackage.requirements = [];

    expectRejected(
      benchmark,
      /truthPackage\.requirements must be a non-empty array/,
    );
  });

  test("rejects a null fact entry as a validation error, not a crash", () => {
    const benchmark = valid();
    benchmark.truthPackage.requirements[0] = null as unknown as TruthFact;

    expectRejected(benchmark, /A fact entry is not an object/);
  });

  test("rejects a fact with an empty id", () => {
    const benchmark = valid();
    benchmark.truthPackage.requirements[0].id = "";

    expectRejected(benchmark, /A fact has an empty id/);
  });

  test("rejects duplicate fact ids", () => {
    const benchmark = valid();
    benchmark.truthPackage.requirements.push({
      id: "spanning",
      versions: [{ statement: "clash", fromCheckpoint: "T0" }],
    });

    expectRejected(benchmark, /Duplicate fact id "spanning"/);
  });

  test("rejects a fact with no versions", () => {
    const benchmark = valid();
    benchmark.truthPackage.requirements[0].versions = [];

    expectRejected(benchmark, /must have at least one version/);
  });

  test("rejects a null version entry as a validation error, not a crash", () => {
    const benchmark = valid();
    benchmark.truthPackage.requirements[0].versions[0] =
      null as unknown as TruthFactVersion;

    expectRejected(benchmark, /has a version that is not an object/);
  });

  test("rejects a version with an empty statement", () => {
    const benchmark = valid();
    benchmark.truthPackage.requirements[0].versions[0].statement = "";

    expectRejected(benchmark, /has a version with an empty statement/);
  });

  test("rejects malformed requirement evidence references", () => {
    const benchmark = valid();
    benchmark.truthPackage.requirements[0].versions[0].evidenceRefs = [""];

    expectRejected(benchmark, /invalid evidenceRefs/);
  });

  test("rejects an unknown fromCheckpoint reference", () => {
    const benchmark = valid();
    benchmark.truthPackage.requirements[0].versions[0].fromCheckpoint = "T9";

    expectRejected(benchmark, /unknown fromCheckpoint "T9"/);
  });

  test("rejects an unknown untilCheckpoint reference", () => {
    const benchmark = valid();
    benchmark.truthPackage.requirements[0].versions[0].untilCheckpoint = "T9";

    expectRejected(benchmark, /unknown untilCheckpoint "T9"/);
  });

  test("rejects an untilCheckpoint equal to its fromCheckpoint", () => {
    const benchmark = valid();
    benchmark.truthPackage.requirements[0].versions[0].untilCheckpoint = "T0";

    expectRejected(
      benchmark,
      /untilCheckpoint is not after its fromCheckpoint/,
    );
  });

  test("rejects an untilCheckpoint before its fromCheckpoint", () => {
    const benchmark = valid();
    benchmark.truthPackage.requirements[0].versions[0].fromCheckpoint = "T1";
    benchmark.truthPackage.requirements[0].versions[0].untilCheckpoint = "T0";

    expectRejected(
      benchmark,
      /untilCheckpoint is not after its fromCheckpoint/,
    );
  });

  test("rejects overlapping version ranges within one fact", () => {
    const benchmark = valid();
    // spanning covers [T0, end); add a second version [T1, end) that overlaps it.
    benchmark.truthPackage.requirements[0].versions.push({
      statement: "overlaps",
      fromCheckpoint: "T1",
    });

    expectRejected(benchmark, /overlapping version ranges/);
  });
});
