import { describe, expect, test } from "vitest";

import type {
  CheckpointEvaluation,
  EvaluationBackend,
  EvaluationInput,
} from "../../core/types.js";
import { runDefectHarness } from "./defect-harness.js";

class FixtureSemanticBackend implements EvaluationBackend {
  async evaluate(input: EvaluationInput): Promise<CheckpointEvaluation> {
    const content = input.artifact.documents[0]?.content ?? "";
    const claims = content
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2));
    const activeByStatement = new Map(
      input.surface.map((fact) => [fact.statement, fact.factVersionId]),
    );
    const obsoleteByStatement = new Map(
      input.obsoleteFacts.map((fact) => [
        fact.obsoleteStatement,
        fact.factVersionId,
      ]),
    );

    return {
      factEvaluations: input.surface.map((fact) => ({
        factId: fact.factId,
        factVersionId: fact.factVersionId,
        verdict: content.includes(fact.statement) ? "correct" : "missing",
        evidence: [],
        rationale: "Deterministic fixture judgment.",
      })),
      forgettingEvaluations: input.obsoleteFacts.map((fact) => ({
        factId: fact.factId,
        factVersionId: fact.factVersionId,
        verdict: content.includes(fact.obsoleteStatement)
          ? "lingering"
          : "forgotten",
        evidence: [],
        rationale: "Deterministic fixture judgment.",
      })),
      precisionEvaluations: claims.map((claim) => {
        const activeVersion = activeByStatement.get(claim);
        const obsoleteVersion = obsoleteByStatement.get(claim);
        if (activeVersion !== undefined) {
          return {
            assertion: claim,
            location: "ledger.md",
            verdict: "supported" as const,
            tense: "current" as const,
            adjudicatedBy: "ledger" as const,
            evidenceIds: [activeVersion],
            rationale: "Active truth ledger supports the claim.",
          };
        }
        if (obsoleteVersion !== undefined) {
          return {
            assertion: claim,
            location: "ledger.md",
            verdict: "stale" as const,
            tense: "current" as const,
            adjudicatedBy: "ledger" as const,
            evidenceIds: [obsoleteVersion],
            rationale: "Superseded truth ledger establishes former truth.",
          };
        }
        if (claim === "add(a, b) returns the difference a - b.") {
          return {
            assertion: claim,
            location: "ledger.md",
            verdict: "invented" as const,
            tense: "current" as const,
            adjudicatedBy: "source" as const,
            evidenceIds: ["src/calc.ts"],
            rationale: "Current source refutes the seeded export.",
          };
        }
        return {
          assertion: claim,
          location: "ledger.md",
          verdict: "unverified" as const,
          tense: "current" as const,
          adjudicatedBy: "none" as const,
          evidenceIds: [],
          rationale: "The claim is neither established nor refuted.",
        };
      }),
    };
  }
}

describe("measurement defect harness", () => {
  test("kills D1-D5 and keeps the clean baseline free of invented claims", async () => {
    const report = await runDefectHarness({
      backend: new FixtureSemanticBackend(),
    });

    expect(report.cleanInventedCount).toBe(0);
    expect(report.defects.map(({ id, passed }) => ({ id, passed }))).toEqual([
      { id: "D1", passed: true },
      { id: "D2", passed: true },
      { id: "D3", passed: true },
      { id: "D4", passed: true },
      { id: "D5", passed: true },
    ]);
    expect(report.passed).toBe(true);
  }, 30_000);
});
