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
          KEB_EVALUATOR_MODEL_ID: "judge",
        },
        "/evals/keb",
      ),
    ).toEqual({
      benchmarkDir: path.resolve("bench"),
      sourceRunDir: path.resolve("old-run"),
      resultsDir: "/evals/keb/.results",
      provider: "anthropic",
      evaluatorModelId: "judge",
    });
  });

  test("requires a completed source run", () => {
    expect(() =>
      resolveReevaluationConfig(
        ["--benchmark", "bench"],
        { OPENWIKI_PROVIDER: "anthropic", OPENWIKI_MODEL_ID: "judge" },
        "/evals/keb",
      ),
    ).toThrow(/completed run directory is required/u);
  });
});
