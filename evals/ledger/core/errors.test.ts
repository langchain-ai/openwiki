import { describe, expect, test } from "vitest";

import {
  BenchmarkValidationError,
  EvaluationError,
  GitReplayError,
  LedgerError,
  SystemRunError,
  WorktreeSafetyError,
} from "./errors.js";

/**
 * Each concrete subclass paired with the `name` it must report. Every entry is a
 * behaviourless `extends LedgerError {}`, so one table drives the name, message, and
 * `instanceof` assertions for all of them.
 */
const SUBCLASSES: ReadonlyArray<{
  readonly name: string;
  readonly construct: (message: string) => LedgerError;
}> = [
  {
    name: "BenchmarkValidationError",
    construct: (message) => new BenchmarkValidationError(message),
  },
  {
    name: "WorktreeSafetyError",
    construct: (message) => new WorktreeSafetyError(message),
  },
  {
    name: "GitReplayError",
    construct: (message) => new GitReplayError(message),
  },
  {
    name: "SystemRunError",
    construct: (message) => new SystemRunError(message),
  },
  {
    name: "EvaluationError",
    construct: (message) => new EvaluationError(message),
  },
];

describe("LedgerError", () => {
  test("is an Error whose name is its own class name", () => {
    const error = new LedgerError("base failure");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("LedgerError");
    expect(error.message).toBe("base failure");
  });

  test('stringifies with the concrete class name, not a bare "Error"', () => {
    // `name` feeds Error.prototype.toString, so a thrown subclass reads as itself
    // in logs and stack traces rather than as an anonymous Error.
    expect(String(new WorktreeSafetyError("escaped root"))).toBe(
      "WorktreeSafetyError: escaped root",
    );
  });
});

describe.each(SUBCLASSES)("$name", ({ name, construct }) => {
  test("reports its own class name", () => {
    expect(construct("boom").name).toBe(name);
  });

  test("preserves the message passed to the constructor", () => {
    expect(construct("boom").message).toBe("boom");
  });

  test("is catchable as both LedgerError and Error", () => {
    const error = construct("boom");

    expect(error).toBeInstanceOf(LedgerError);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("subclass discrimination", () => {
  test("distinct subclasses are not instances of one another", () => {
    const safety: unknown = new WorktreeSafetyError("escaped root");

    expect(safety).toBeInstanceOf(WorktreeSafetyError);
    expect(safety).not.toBeInstanceOf(BenchmarkValidationError);
    expect(safety).not.toBeInstanceOf(GitReplayError);
  });

  test("a benchmark error is distinguishable from a safety error", () => {
    // These two matter most to keep apart: a benchmark-authoring mistake is a
    // recoverable data problem, a containment breach is a hard safety stop.
    const validation: unknown = new BenchmarkValidationError("bad trace");

    expect(validation).toBeInstanceOf(BenchmarkValidationError);
    expect(validation).not.toBeInstanceOf(WorktreeSafetyError);
  });
});
