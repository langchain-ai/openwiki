import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ModelEvaluationBackend } from "./model-backend.js";
import { resolveCoverage, runCoveragePass } from "./coverage.js";
import { SectionBm25Index } from "./retrieval.js";
import { EvaluationError } from "../core/errors.js";
import { resolveForgetting, runForgettingPass } from "./forgetting.js";
import {
  assertionExtractionOutputSchema,
  coverageOutputSchema,
  forgettingOutputSchema,
  precisionJudgmentOutputSchema,
} from "./schemas.js";
import type {
  ActiveTruthFact,
  KnowledgeArtifact,
  ObsoleteFactTarget,
} from "../core/types.js";

describe("schemas", () => {
  test("coverage schema defaults absent evidence to an empty array", () => {
    const parsed = coverageOutputSchema.parse({
      evaluations: [{ factId: "a", verdict: "correct", rationale: "ok" }],
    });

    expect(parsed.evaluations[0].evidence).toEqual([]);
  });

  test("coverage schema rejects an unknown verdict", () => {
    expect(() =>
      coverageOutputSchema.parse({
        evaluations: [{ factId: "a", verdict: "great", rationale: "" }],
      }),
    ).toThrow();
  });

  test("precision and forgetting schemas accept well-formed output", () => {
    const extraction = assertionExtractionOutputSchema.parse({
      units: [
        {
          unitId: "a::0000::unit-0000",
          classification: "factual",
          assertions: [{ statement: "A fact.", tense: "current" }],
          rationale: "The unit states a checkable fact.",
        },
      ],
    });
    const precision = precisionJudgmentOutputSchema.parse({
      evaluations: [
        {
          assertionId: "assertion-000001",
          verdict: "contradicted",
          evidenceIds: ["source::0000"],
          formerlyTrue: false,
          rationale: "The source refutes it.",
        },
        {
          assertionId: "assertion-000002",
          verdict: "not-refuted",
          rationale: "The source does not refute it.",
        },
      ],
    });

    expect(extraction.units[0].assertions).toEqual([
      { statement: "A fact.", tense: "current" },
    ]);
    // Named evidence ids survive; an omitted list defaults to empty.
    expect(precision.evaluations[0].evidenceIds).toEqual(["source::0000"]);
    expect(precision.evaluations[1].evidenceIds).toEqual([]);

    expect(() =>
      forgettingOutputSchema.parse({
        evaluations: [
          { factVersionId: "a@T0", verdict: "lingering", rationale: "" },
        ],
      }),
    ).not.toThrow();
  });
});

describe("resolveCoverage", () => {
  const activeFacts: ActiveTruthFact[] = [
    { factId: "a", factVersionId: "a@T0", category: "x", statement: "A" },
    { factId: "b", factVersionId: "b@T0", category: "x", statement: "B" },
  ];

  test("maps every requested fact and attaches the factVersionId", () => {
    const resolved = resolveCoverage(activeFacts, {
      evaluations: [
        {
          factId: "a",
          verdict: "correct",
          evidence: ["artifact/a.md"],
          rationale: "",
        },
        { factId: "b", verdict: "missing", evidence: [], rationale: "" },
      ],
    });

    expect(resolved.map((e) => [e.factId, e.factVersionId, e.verdict])).toEqual(
      [
        ["a", "a@T0", "correct"],
        ["b", "b@T0", "missing"],
      ],
    );
  });

  test("throws when a requested fact has no verdict", () => {
    expect(() =>
      resolveCoverage(activeFacts, {
        evaluations: [
          { factId: "a", verdict: "correct", evidence: [], rationale: "" },
        ],
      }),
    ).toThrow(EvaluationError);
  });

  test("throws on an unknown fact id", () => {
    expect(() =>
      resolveCoverage(activeFacts, {
        evaluations: [
          { factId: "a", verdict: "correct", evidence: [], rationale: "" },
          { factId: "b", verdict: "correct", evidence: [], rationale: "" },
          { factId: "ghost", verdict: "correct", evidence: [], rationale: "" },
        ],
      }),
    ).toThrow(EvaluationError);
  });

  test("throws on a duplicate verdict", () => {
    expect(() =>
      resolveCoverage(activeFacts, {
        evaluations: [
          { factId: "a", verdict: "correct", evidence: [], rationale: "" },
          { factId: "a", verdict: "partial", evidence: [], rationale: "" },
          { factId: "b", verdict: "correct", evidence: [], rationale: "" },
        ],
      }),
    ).toThrow(EvaluationError);
  });
});

describe("resolveForgetting", () => {
  const targets: ObsoleteFactTarget[] = [
    { factId: "a", factVersionId: "a@T0", obsoleteStatement: "old A" },
    { factId: "b", factVersionId: "b@T0", obsoleteStatement: "old B" },
  ];

  test("maps every requested version keyed by factVersionId", () => {
    const resolved = resolveForgetting(targets, {
      evaluations: [
        {
          factVersionId: "a@T0",
          verdict: "lingering",
          evidence: ["artifact/a.md"],
          rationale: "",
        },
        {
          factVersionId: "b@T0",
          verdict: "forgotten",
          evidence: [],
          rationale: "",
        },
      ],
    });

    expect(resolved.map((e) => [e.factVersionId, e.verdict])).toEqual([
      ["a@T0", "lingering"],
      ["b@T0", "forgotten"],
    ]);
  });

  test("carries the factId alongside the version verdict", () => {
    const resolved = resolveForgetting(targets, {
      evaluations: [
        {
          factVersionId: "a@T0",
          verdict: "forgotten",
          evidence: [],
          rationale: "",
        },
        {
          factVersionId: "b@T0",
          verdict: "forgotten",
          evidence: [],
          rationale: "",
        },
      ],
    });

    // The resolver re-attaches the originating factId from the request, which
    // the raw forgetting output never carries.
    expect(resolved.map((e) => e.factId)).toEqual(["a", "b"]);
  });

  test("throws when a requested version has no verdict", () => {
    expect(() =>
      resolveForgetting(targets, {
        evaluations: [
          {
            factVersionId: "a@T0",
            verdict: "lingering",
            evidence: [],
            rationale: "",
          },
        ],
      }),
    ).toThrow(EvaluationError);
  });

  test("throws on an unknown factVersionId", () => {
    expect(() =>
      resolveForgetting(targets, {
        evaluations: [
          {
            factVersionId: "a@T0",
            verdict: "forgotten",
            evidence: [],
            rationale: "",
          },
          {
            factVersionId: "b@T0",
            verdict: "forgotten",
            evidence: [],
            rationale: "",
          },
          {
            factVersionId: "ghost@T0",
            verdict: "forgotten",
            evidence: [],
            rationale: "",
          },
        ],
      }),
    ).toThrow(EvaluationError);
  });

  test("throws on a duplicate version verdict", () => {
    expect(() =>
      resolveForgetting(targets, {
        evaluations: [
          {
            factVersionId: "a@T0",
            verdict: "forgotten",
            evidence: [],
            rationale: "",
          },
          {
            factVersionId: "a@T0",
            verdict: "lingering",
            evidence: [],
            rationale: "",
          },
          {
            factVersionId: "b@T0",
            verdict: "forgotten",
            evidence: [],
            rationale: "",
          },
        ],
      }),
    ).toThrow(EvaluationError);
  });
});

describe("empty-input passes short-circuit", () => {
  // The model is never touched on the empty path, so a bare cast is safe: the
  // point is that no agent is built and no provider call is made.
  const model = {} as unknown as BaseChatModel;

  test("coverage returns no evaluations without invoking a model", async () => {
    await expect(
      runCoveragePass({
        model,
        checkpointId: "T0",
        activeFacts: [],
        index: new SectionBm25Index([]),
      }),
    ).resolves.toEqual([]);
  });

  test("forgetting returns no evaluations without invoking a model", async () => {
    await expect(
      runForgettingPass({
        model,
        checkpointId: "T0",
        obsoleteFacts: [],
        index: new SectionBm25Index([]),
      }),
    ).resolves.toEqual([]);
  });
});

// Live test: requires LEDGER_LIVE plus provider credentials. Skipped by default so
// the main suite stays offline.
describe.skipIf(!process.env.LEDGER_LIVE)(
  "ModelEvaluationBackend (live)",
  () => {
    let snapshotDir: string;

    beforeAll(async () => {
      snapshotDir = await mkdtemp(path.join(os.tmpdir(), "ledger-snap-"));
      await writeFile(
        path.join(snapshotDir, "overview.md"),
        "# Overview\n\nThe service authenticates requests with an API key passed in the `X-Api-Key` header.\n",
        "utf8",
      );
    });

    afterAll(async () => {
      await rm(snapshotDir, { recursive: true, force: true });
    });

    test("marks a clearly-stated fact correct", async () => {
      const backend = new ModelEvaluationBackend({
        provider: process.env.OPENWIKI_PROVIDER ?? "anthropic",
        modelId: process.env.LEDGER_EVALUATOR_MODEL_ID ?? "claude-sonnet-5",
      });

      const artifact: KnowledgeArtifact = {
        checkpointId: "T0",
        snapshotDir,
        fingerprint: "x",
        documents: [
          {
            relativePath: "overview.md",
            content:
              "# Overview\n\nThe service authenticates requests with an API key passed in the `X-Api-Key` header.\n",
          },
        ],
      };

      const evaluation = await backend.evaluate({
        artifact,
        activeFacts: [
          {
            factId: "auth",
            factVersionId: "auth@T0",
            category: "api",
            statement:
              "Requests authenticate with an API key in the X-Api-Key header.",
          },
        ],
        evidence: {
          checkpointId: "T0",
          records: [
            {
              evidenceId: "source/auth.ts::0000",
              sourceRef: "source/auth.ts",
              observedAtCheckpoint: "T0",
              current: true,
              content:
                "Requests authenticate with an API key in the X-Api-Key header.",
            },
          ],
        },
        obsoleteFacts: [],
      });

      expect(evaluation.factEvaluations[0].verdict).toBe("correct");
    });
  },
);
