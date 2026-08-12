import { describe, expect, test } from "vitest";

import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  test("parses space- and equals-separated flags", () => {
    expect(
      parseArgs(["--benchmark", "b", "--results=out", "--system-model", "m"]),
    ).toEqual({ benchmark: "b", results: "out", systemModel: "m" });
  });

  test("parses the evaluator-model flag", () => {
    expect(parseArgs(["--evaluator-model=eval-x"])).toEqual({
      evaluatorModel: "eval-x",
    });
  });

  test("parses verbose as a valueless flag", () => {
    expect(parseArgs(["--benchmark", "bench", "--verbose"])).toEqual({
      benchmark: "bench",
      verbose: true,
    });
    expect(() => parseArgs(["--verbose=true"])).toThrow(
      /does not accept a value/u,
    );
  });

  test("returns an empty object for no arguments", () => {
    expect(parseArgs([])).toEqual({});
  });

  test("rejects an unknown flag", () => {
    expect(() => parseArgs(["--nope", "x"])).toThrow(/Unknown argument/);
  });

  test("rejects a missing value", () => {
    expect(() => parseArgs(["--benchmark"])).toThrow(/Missing value/);
  });
});
