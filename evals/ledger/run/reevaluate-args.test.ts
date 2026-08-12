import path from "node:path";

import { describe, expect, test } from "vitest";

import { resolveReevaluationConfig } from "./reevaluate-args.js";

describe("resolveReevaluationConfig", () => {
  test("resolves required paths and evaluator environment defaults", () => {
    expect(
      resolveReevaluationConfig(
        ["--benchmark", "bench", "--run=old-run"],
        {
          OPENWIKI_PROVIDER: "anthropic",
          LEDGER_EVALUATOR_MODEL_ID: "judge",
        },
        "/evals/ledger",
      ),
    ).toEqual({
      verbose: false,
      benchmarkDir: path.resolve("bench"),
      sourceRunDir: path.resolve("old-run"),
      resultsDir: "/evals/ledger/.results",
      provider: "anthropic",
      evaluatorModelId: "judge",
    });
  });

  test("enables verbose claim output", () => {
    expect(
      resolveReevaluationConfig(
        ["--benchmark", "bench", "--run", "old-run", "--verbose"],
        {
          OPENWIKI_PROVIDER: "anthropic",
          LEDGER_EVALUATOR_MODEL_ID: "judge",
        },
        "/evals/ledger",
      ).verbose,
    ).toBe(true);
  });

  test("requires a completed source run", () => {
    expect(() =>
      resolveReevaluationConfig(
        ["--benchmark", "bench"],
        { OPENWIKI_PROVIDER: "anthropic", OPENWIKI_MODEL_ID: "judge" },
        "/evals/ledger",
      ),
    ).toThrow(/completed run directory is required/u);
  });
});
