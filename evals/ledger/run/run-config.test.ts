import path from "node:path";

import { describe, expect, test } from "vitest";

import { LedgerError } from "../core/errors.js";
import { resolveRunConfig } from "./run-config.js";

/**
 * The eval directory the default results path is resolved against. Any absolute
 * path works for the offline test; nothing is read or written.
 */
const EVAL_DIR = "/abs/evals/ledger";

describe("resolveRunConfig", () => {
  test("resolves paths and threads the provider through", () => {
    const config = resolveRunConfig(
      { benchmark: "bench", systemModel: "sys-m" },
      { OPENWIKI_PROVIDER: "anthropic" },
      EVAL_DIR,
    );

    expect(config.provider).toBe("anthropic");
    expect(config.benchmarkDir).toBe(path.resolve("bench"));
    expect(config.systemModelId).toBe("sys-m");
    // The evaluator model falls back to the system model when nothing else is set.
    expect(config.evaluatorModelId).toBe("sys-m");
    expect(config.resultsDir).toBe(path.join(EVAL_DIR, ".results"));
  });

  test("prefers CLI flags over the environment", () => {
    const config = resolveRunConfig(
      {
        benchmark: "bench",
        systemModel: "flag-sys",
        evaluatorModel: "flag-eval",
      },
      {
        OPENWIKI_PROVIDER: "openai",
        OPENWIKI_MODEL_ID: "env-sys",
        LEDGER_EVALUATOR_MODEL_ID: "env-eval",
      },
      EVAL_DIR,
    );

    expect(config.systemModelId).toBe("flag-sys");
    expect(config.evaluatorModelId).toBe("flag-eval");
  });

  test("falls back to env model ids when no flags are given", () => {
    const config = resolveRunConfig(
      { benchmark: "bench" },
      {
        OPENWIKI_PROVIDER: "openai",
        OPENWIKI_MODEL_ID: "env-sys",
        LEDGER_EVALUATOR_MODEL_ID: "env-eval",
      },
      EVAL_DIR,
    );

    expect(config.systemModelId).toBe("env-sys");
    expect(config.evaluatorModelId).toBe("env-eval");
  });

  test("resolves an explicit results override to an absolute path", () => {
    const config = resolveRunConfig(
      { benchmark: "bench", results: "out", systemModel: "m" },
      { OPENWIKI_PROVIDER: "anthropic" },
      EVAL_DIR,
    );

    expect(config.resultsDir).toBe(path.resolve("out"));
  });

  test("throws when the benchmark directory is missing", () => {
    expect(() =>
      resolveRunConfig({}, { OPENWIKI_PROVIDER: "anthropic" }, EVAL_DIR),
    ).toThrow(LedgerError);
  });

  test("throws when the provider is unset or empty", () => {
    expect(() =>
      resolveRunConfig({ benchmark: "bench" }, {}, EVAL_DIR),
    ).toThrow(/OPENWIKI_PROVIDER/);
    expect(() =>
      resolveRunConfig(
        { benchmark: "bench" },
        { OPENWIKI_PROVIDER: "" },
        EVAL_DIR,
      ),
    ).toThrow(/OPENWIKI_PROVIDER/);
  });

  test("throws when no evaluator model can be resolved", () => {
    expect(() =>
      resolveRunConfig(
        { benchmark: "bench" },
        { OPENWIKI_PROVIDER: "anthropic" },
        EVAL_DIR,
      ),
    ).toThrow(/evaluator model id is required/);
  });
});
