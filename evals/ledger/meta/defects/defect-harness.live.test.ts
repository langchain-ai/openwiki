import { describe, expect, test } from "vitest";

import { ModelEvaluationBackend } from "../../evaluator/model-backend.js";
import { runDefectHarness } from "./defect-harness.js";

describe.skipIf(!process.env.LEDGER_LIVE)(
  "measurement defect harness (live)",
  () => {
    test("kills every seeded evaluator defect", async () => {
      const report = await runDefectHarness({
        backend: new ModelEvaluationBackend({
          provider: process.env.OPENWIKI_PROVIDER ?? "anthropic",
          modelId:
            process.env.LEDGER_EVALUATOR_MODEL_ID ??
            process.env.OPENWIKI_MODEL_ID ??
            "claude-sonnet-5",
        }),
      });

      process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
      expect(report.passed).toBe(true);
    }, 1_800_000);
  },
);
