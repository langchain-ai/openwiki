import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { describe, expect, test } from "vitest";

import type { ObsoleteFactTarget, SurfaceItem } from "../core/types.js";
import { runCoveragePass } from "./coverage.js";
import type { ArtifactSection } from "./documents.js";
import { runForgettingPass } from "./forgetting.js";
import { FORGETTING_SYSTEM } from "./prompts.js";
import { SectionBm25Index } from "./retrieval.js";

/**
 * Queued structured responses and invocation telemetry for a model test double.
 */
interface ModelController {
  /**
   * Structured values or errors consumed in invocation order.
   */
  responses: Array<unknown | Error>;

  /**
   * User prompts received in invocation order.
   */
  taskPrompts: string[];

  /**
   * System prompts received in invocation order.
   */
  systemPrompts: string[];

  /**
   * Number of invocations currently awaiting their queued response.
   */
  active: number;

  /**
   * Highest observed number of simultaneous invocations.
   */
  maxActive: number;
}

/**
 * Build a complete artifact-section fixture.
 *
 * @param id - Stable section identifier.
 * @param content - Markdown and searchable content.
 *
 * @returns Artifact section suitable for a BM25 index.
 */
function section(id: string, content: string): ArtifactSection {
  return {
    id,
    relativePath: `${id}.md`,
    headingPath: [id],
    ordinal: 0,
    content,
    searchableText: `${id}.md\n${id}\n${content}`,
  };
}

/**
 * Build a public-surface item fixture the coverage pass scores.
 *
 * @param factId - Stable logical surface id.
 * @param statement - Self-contained claim describing the surface element.
 *
 * @returns Surface item fixture.
 */
function surfaceItem(factId: string, statement: string): SurfaceItem {
  return {
    factId,
    factVersionId: `${factId}@T0`,
    kind: "symbol",
    name: factId,
    statement,
  };
}

/**
 * Build an obsolete source-surface version fixture.
 *
 * @param factId - Stable logical fact identifier.
 * @param obsoleteStatement - Statement no longer true.
 *
 * @returns Obsolete fact target fixture.
 */
function obsoleteFact(
  factId: string,
  obsoleteStatement: string,
): ObsoleteFactTarget {
  return {
    factId,
    factVersionId: `${factId}@T0`,
    obsoleteStatement,
  };
}

/**
 * Create fresh queued model state.
 *
 * @param responses - Structured values or errors returned in order.
 *
 * @returns Mutable controller used by the model test double.
 */
function controller(responses: Array<unknown | Error>): ModelController {
  return {
    responses,
    taskPrompts: [],
    systemPrompts: [],
    active: 0,
    maxActive: 0,
  };
}

/**
 * Build the direct structured-output model surface used by bounded passes.
 *
 * @param control - Queued behavior and invocation telemetry.
 *
 * @returns BaseChatModel-compatible test double.
 */
function fakeModel(control: ModelController): BaseChatModel {
  return {
    withStructuredOutput: () => ({
      invoke: async (messages: Array<{ role: string; content: string }>) => {
        control.systemPrompts.push(messages[0].content);
        control.taskPrompts.push(messages[1].content);
        control.active += 1;
        control.maxActive = Math.max(control.maxActive, control.active);

        try {
          await Promise.resolve();
          const response = control.responses.shift();

          if (response instanceof Error) {
            throw response;
          }

          return response;
        } finally {
          control.active -= 1;
        }
      },
    }),
  } as unknown as BaseChatModel;
}

/**
 * Parse the JSON target array appended to a bounded task prompt.
 *
 * @param prompt - Coverage or forgetting task prompt.
 *
 * @returns Parsed target records.
 */
function promptTargets(prompt: string): Array<Record<string, unknown>> {
  const marker = "Targets (JSON):\n";
  const offset = prompt.indexOf(marker);

  if (offset === -1) {
    throw new Error("Prompt has no target JSON marker.");
  }

  return JSON.parse(prompt.slice(offset + marker.length)) as Array<
    Record<string, unknown>
  >;
}

describe("runCoveragePass", () => {
  test("uses per-fact BM25 excerpts, stable target batches, and input result order", async () => {
    const facts = [
      surfaceItem("b", "beta behavior"),
      surfaceItem("a", "alpha behavior"),
      surfaceItem("c", "gamma behavior"),
    ];
    const control = controller([
      {
        evaluations: [
          {
            factId: "a",
            verdict: "correct",
            evidence: ["a-section"],
            rationale: "alpha",
          },
          {
            factId: "b",
            verdict: "correct",
            evidence: ["b-section"],
            rationale: "beta",
          },
        ],
      },
      {
        evaluations: [
          {
            factId: "c",
            verdict: "correct",
            evidence: ["c-section"],
            rationale: "gamma",
          },
        ],
      },
    ]);
    const index = new SectionBm25Index([
      section("a-section", "alpha behavior"),
      section("b-section", "beta behavior"),
      section("c-section", "gamma behavior"),
    ]);

    const evaluations = await runCoveragePass({
      model: fakeModel(control),
      checkpointId: "T0",
      surface: facts,
      index,
      topK: 1,
      batchSize: 2,
    });

    expect(evaluations.map((evaluation) => evaluation.factId)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(control.taskPrompts).toHaveLength(2);
    expect(control.maxActive).toBe(1);

    const firstTargets = promptTargets(control.taskPrompts[0]);
    expect(firstTargets.map((target) => target.factId)).toEqual(["b", "a"]);
    expect(firstTargets[0].excerpts).toEqual([
      expect.objectContaining({ sectionId: "b-section" }),
    ]);
    expect(firstTargets[1].excerpts).toEqual([
      expect.objectContaining({ sectionId: "a-section" }),
    ]);
  });

  test("checks every remaining section before finalizing missing", async () => {
    const sections = Array.from({ length: 10 }, (_, index) =>
      section(
        `s${String(index).padStart(2, "0")}`,
        index === 9 ? "needle initial candidate" : `unrelated ${index}`,
      ),
    );
    const control = controller([
      {
        evaluations: [
          { factId: "f", verdict: "missing", evidence: [], rationale: "no" },
        ],
      },
      {
        evaluations: [
          { factId: "f", verdict: "missing", evidence: [], rationale: "no" },
        ],
      },
      {
        evaluations: [
          {
            factId: "f",
            verdict: "correct",
            evidence: ["s08"],
            rationale: "found",
          },
        ],
      },
    ]);

    const [evaluation] = await runCoveragePass({
      model: fakeModel(control),
      checkpointId: "T0",
      surface: [surfaceItem("f", "needle")],
      index: new SectionBm25Index(sections),
      topK: 1,
    });

    expect(evaluation.verdict).toBe("correct");
    expect(control.taskPrompts).toHaveLength(3);
    const requestedIds = control.taskPrompts.flatMap((prompt) => {
      const [target] = promptTargets(prompt);
      return (target.excerpts as Array<{ sectionId: string }>).map(
        (excerpt) => excerpt.sectionId,
      );
    });
    expect(requestedIds).toHaveLength(10);
    expect(new Set(requestedIds).size).toBe(10);
  });

  test("stops exhaustive fallback as soon as a non-missing verdict is found", async () => {
    const sections = Array.from({ length: 18 }, (_, index) =>
      section(
        `s${String(index).padStart(2, "0")}`,
        index === 0 ? "needle" : `other ${index}`,
      ),
    );
    const control = controller([
      {
        evaluations: [
          { factId: "f", verdict: "missing", evidence: [], rationale: "no" },
        ],
      },
      {
        evaluations: [
          {
            factId: "f",
            verdict: "partial",
            evidence: ["s01"],
            rationale: "part",
          },
        ],
      },
    ]);

    const [evaluation] = await runCoveragePass({
      model: fakeModel(control),
      checkpointId: "T0",
      surface: [surfaceItem("f", "needle")],
      index: new SectionBm25Index(sections),
      topK: 1,
    });

    expect(evaluation.verdict).toBe("partial");
    expect(control.taskPrompts).toHaveLength(2);
  });

  test("isolates then marks an irreparable coverage citation indeterminate", async () => {
    const invalid = {
      evaluations: [
        {
          factId: "f",
          verdict: "correct",
          evidence: ["unseen"],
          rationale: "invented citation",
        },
      ],
    };
    const control = controller([invalid, invalid, invalid]);
    const warnings: string[] = [];

    const [evaluation] = await runCoveragePass({
      model: fakeModel(control),
      checkpointId: "T3",
      surface: [surfaceItem("f", "fact")],
      index: new SectionBm25Index([section("seen", "fact")]),
      onWarning: (warning) => warnings.push(warning.itemId),
    });

    expect(evaluation.verdict).toBe("indeterminate");
    expect(warnings).toEqual(["f"]);
    expect(control.taskPrompts).toHaveLength(3);
  });

  test("preserves valid coverage neighbors when one item is indeterminate", async () => {
    const invalidItem = {
      evaluations: [
        {
          factId: "broken",
          verdict: "correct",
          evidence: ["unseen"],
          rationale: "invented citation",
        },
      ],
    };
    const control = controller([
      {
        evaluations: [
          {
            factId: "valid",
            verdict: "correct",
            evidence: ["seen"],
            rationale: "visible evidence",
          },
          ...invalidItem.evaluations,
        ],
      },
      invalidItem,
      invalidItem,
    ]);

    const evaluations = await runCoveragePass({
      model: fakeModel(control),
      checkpointId: "T3",
      surface: [surfaceItem("valid", "fact"), surfaceItem("broken", "fact")],
      index: new SectionBm25Index([section("seen", "fact")]),
    });

    expect(evaluations.map((evaluation) => evaluation.verdict)).toEqual([
      "correct",
      "indeterminate",
    ]);
  });

  test("accepts evidence supplied for another fact in the same bounded request", async () => {
    const control = controller([
      {
        evaluations: [
          {
            factId: "alpha",
            verdict: "correct",
            evidence: ["beta-section"],
            rationale: "The request includes this supporting section.",
          },
          {
            factId: "beta",
            verdict: "correct",
            evidence: ["beta-section"],
            rationale: "The section supports this fact too.",
          },
        ],
      },
    ]);

    const evaluations = await runCoveragePass({
      model: fakeModel(control),
      checkpointId: "T0",
      surface: [
        surfaceItem("alpha", "alpha behavior"),
        surfaceItem("beta", "beta behavior"),
      ],
      index: new SectionBm25Index([
        section("alpha-section", "alpha behavior"),
        section("beta-section", "beta behavior and alpha behavior"),
      ]),
      topK: 1,
      batchSize: 2,
    });

    expect(evaluations[0].evidence).toEqual(["beta-section"]);
    expect(control.taskPrompts).toHaveLength(1);
  });

  test("accepts valid related evidence for a missing coverage verdict", async () => {
    const control = controller([
      {
        evaluations: [
          {
            factId: "edge-cases",
            verdict: "missing",
            evidence: ["api-section"],
            rationale:
              "The API section documents the function but omits its edge cases.",
          },
        ],
      },
    ]);

    const [evaluation] = await runCoveragePass({
      model: fakeModel(control),
      checkpointId: "T1",
      surface: [
        surfaceItem("edge-cases", "The API documents numeric edge cases."),
      ],
      index: new SectionBm25Index([
        section("api-section", "The API documents the add function."),
      ]),
    });

    expect(evaluation).toMatchObject({
      verdict: "missing",
      evidence: ["api-section"],
    });
    expect(control.taskPrompts).toHaveLength(1);
  });

  test("returns deterministic missing without a model for an empty artifact", async () => {
    const control = controller([]);

    const result = await runCoveragePass({
      model: fakeModel(control),
      checkpointId: "T0",
      surface: [surfaceItem("f", "fact")],
      index: new SectionBm25Index([]),
    });

    expect(result[0].verdict).toBe("missing");
    expect(control.taskPrompts).toEqual([]);
  });
});

describe("runForgettingPass", () => {
  test("treats explicit historical language as non-lingering in its contract", async () => {
    const control = controller([
      {
        evaluations: [
          {
            factVersionId: "old@T0",
            verdict: "forgotten",
            evidence: ["history"],
            rationale: "described only as removed",
          },
        ],
      },
    ]);

    const [evaluation] = await runForgettingPass({
      model: fakeModel(control),
      checkpointId: "T1",
      obsoleteFacts: [obsoleteFact("old", "The old option is enabled.")],
      index: new SectionBm25Index([
        section("history", "The old option was removed."),
      ]),
    });

    expect(evaluation.verdict).toBe("forgotten");
    expect(evaluation.evidence).toEqual(["history"]);
    expect(FORGETTING_SYSTEM).toContain(
      'A historical statement such as "this option was removed" is not lingering.',
    );
    expect(FORGETTING_SYSTEM).toContain(
      '"forgotten" may cite supplied excerpts that establish replacement',
    );
    expect(control.systemPrompts[0]).not.toContain("read_file");
  });

  test("checks remaining sections and stops when obsolete knowledge lingers", async () => {
    const sections = Array.from({ length: 10 }, (_, index) =>
      section(
        `s${String(index).padStart(2, "0")}`,
        index === 9 ? "obsolete query terms" : `other ${index}`,
      ),
    );
    const control = controller([
      {
        evaluations: [
          {
            factVersionId: "old@T0",
            verdict: "forgotten",
            evidence: [],
            rationale: "not here",
          },
        ],
      },
      {
        evaluations: [
          {
            factVersionId: "old@T0",
            verdict: "lingering",
            evidence: ["s00"],
            rationale: "still current",
          },
        ],
      },
    ]);

    const [evaluation] = await runForgettingPass({
      model: fakeModel(control),
      checkpointId: "T1",
      obsoleteFacts: [obsoleteFact("old", "obsolete query terms")],
      index: new SectionBm25Index(sections),
      topK: 1,
    });

    expect(evaluation.verdict).toBe("lingering");
    expect(control.taskPrompts).toHaveLength(2);
    expect(control.maxActive).toBe(1);
  });

  test("examines every section before finalizing forgotten", async () => {
    const sections = Array.from({ length: 10 }, (_, index) =>
      section(
        `s${String(index).padStart(2, "0")}`,
        index === 9 ? "obsolete query terms" : `other ${index}`,
      ),
    );
    const forgotten = {
      evaluations: [
        {
          factVersionId: "old@T0",
          verdict: "forgotten",
          evidence: [],
          rationale: "not asserted here",
        },
      ],
    };
    const control = controller([forgotten, forgotten, forgotten]);

    const [evaluation] = await runForgettingPass({
      model: fakeModel(control),
      checkpointId: "T1",
      obsoleteFacts: [obsoleteFact("old", "obsolete query terms")],
      index: new SectionBm25Index(sections),
      topK: 1,
    });

    expect(evaluation.verdict).toBe("forgotten");
    expect(control.taskPrompts).toHaveLength(3);
    const requestedIds = control.taskPrompts.flatMap((prompt) => {
      const [target] = promptTargets(prompt);
      return (target.excerpts as Array<{ sectionId: string }>).map(
        (excerpt) => excerpt.sectionId,
      );
    });
    expect(requestedIds).toHaveLength(10);
    expect(new Set(requestedIds).size).toBe(10);
  });

  test("isolates then marks an irreparable forgetting citation indeterminate", async () => {
    const invalid = {
      evaluations: [
        {
          factVersionId: "old@T0",
          verdict: "lingering",
          evidence: ["unseen"],
          rationale: "invented citation",
        },
      ],
    };
    const control = controller([invalid, invalid, invalid]);
    const warnings: string[] = [];

    const [evaluation] = await runForgettingPass({
      model: fakeModel(control),
      checkpointId: "T2",
      obsoleteFacts: [obsoleteFact("old", "old truth")],
      index: new SectionBm25Index([section("seen", "old truth")]),
      onWarning: (warning) => warnings.push(warning.itemId),
    });

    expect(evaluation.verdict).toBe("indeterminate");
    expect(warnings).toEqual(["old@T0"]);
    expect(control.taskPrompts).toHaveLength(3);
  });

  test("preserves valid forgetting neighbors when one item is indeterminate", async () => {
    const invalidItem = {
      evaluations: [
        {
          factVersionId: "broken@T0",
          verdict: "lingering",
          evidence: ["unseen"],
          rationale: "invented citation",
        },
      ],
    };
    const control = controller([
      {
        evaluations: [
          {
            factVersionId: "valid@T0",
            verdict: "forgotten",
            evidence: [],
            rationale: "absent",
          },
          ...invalidItem.evaluations,
        ],
      },
      invalidItem,
      invalidItem,
    ]);

    const evaluations = await runForgettingPass({
      model: fakeModel(control),
      checkpointId: "T2",
      obsoleteFacts: [
        obsoleteFact("valid", "old truth"),
        obsoleteFact("broken", "old truth"),
      ],
      index: new SectionBm25Index([section("seen", "old truth")]),
    });

    expect(evaluations.map((evaluation) => evaluation.verdict)).toEqual([
      "forgotten",
      "indeterminate",
    ]);
  });

  test("accepts evidence supplied for another version in the same bounded request", async () => {
    const control = controller([
      {
        evaluations: [
          {
            factVersionId: "alpha@T0",
            verdict: "lingering",
            evidence: ["beta-section"],
            rationale: "The request includes the lingering assertion.",
          },
          {
            factVersionId: "beta@T0",
            verdict: "lingering",
            evidence: ["beta-section"],
            rationale: "The obsolete beta statement remains current.",
          },
        ],
      },
    ]);

    const evaluations = await runForgettingPass({
      model: fakeModel(control),
      checkpointId: "T1",
      obsoleteFacts: [
        obsoleteFact("alpha", "alpha obsolete"),
        obsoleteFact("beta", "beta obsolete"),
      ],
      index: new SectionBm25Index([
        section("alpha-section", "alpha obsolete"),
        section("beta-section", "beta obsolete and alpha obsolete"),
      ]),
      topK: 1,
      batchSize: 2,
    });

    expect(evaluations[0].evidence).toEqual(["beta-section"]);
    expect(control.taskPrompts).toHaveLength(1);
  });

  test("returns deterministic forgotten without a model for an empty artifact", async () => {
    const control = controller([]);

    const result = await runForgettingPass({
      model: fakeModel(control),
      checkpointId: "T1",
      obsoleteFacts: [obsoleteFact("old", "old truth")],
      index: new SectionBm25Index([]),
    });

    expect(result[0].verdict).toBe("forgotten");
    expect(control.taskPrompts).toEqual([]);
  });
});
