import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { describe, expect, test } from "vitest";

import type { ObsoleteFactTarget } from "../core/types.js";
import type { ArtifactSection } from "./documents.js";
import { runForgettingPass } from "./forgetting.js";
import { FORGETTING_SYSTEM } from "./prompts.js";
import { SectionBm25Index } from "./retrieval.js";

interface ModelController {
  responses: Array<unknown | Error>;
  taskPrompts: string[];
  systemPrompts: string[];
  active: number;
  maxActive: number;
}

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

function controller(responses: Array<unknown | Error>): ModelController {
  return {
    responses,
    taskPrompts: [],
    systemPrompts: [],
    active: 0,
    maxActive: 0,
  };
}

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

describe("forgetting evaluator", () => {
  test("treats explicit historical language as non-lingering", async () => {
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
    expect(control.systemPrompts[0]).not.toContain("read_file");
  });

  test("scans beyond BM25 candidates and stops when obsolete knowledge lingers", async () => {
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
  });

  test("examines every section before finalizing forgotten", async () => {
    const sections = Array.from({ length: 10 }, (_, index) =>
      section(`s${String(index).padStart(2, "0")}`, `content ${index}`),
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
    const requestedIds = control.taskPrompts.flatMap((prompt) => {
      const [target] = promptTargets(prompt);
      return (target.excerpts as Array<{ sectionId: string }>).map(
        (excerpt) => excerpt.sectionId,
      );
    });
    expect(requestedIds).toHaveLength(10);
    expect(new Set(requestedIds).size).toBe(10);
  });

  test("isolates then marks an irreparable citation indeterminate", async () => {
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

  test("degrades a failed batch and reports the provider cause", async () => {
    const control = controller([
      new Error("provider exploded"),
      new Error("provider exploded"),
      new Error("provider exploded"),
      new Error("provider exploded"),
    ]);
    const warnings: Array<{ itemId: string; message: string }> = [];

    const [evaluation] = await runForgettingPass({
      model: fakeModel(control),
      checkpointId: "T2",
      obsoleteFacts: [obsoleteFact("old", "old truth")],
      index: new SectionBm25Index([section("seen", "old truth")]),
      onWarning: (warning) => warnings.push(warning),
    });

    expect(evaluation.verdict).toBe("indeterminate");
    expect(warnings[0]).toMatchObject({ itemId: "old@T0" });
    expect(warnings[0].message).toContain(
      'pass "forgetting" failed after 2 attempts',
    );
  });

  test("preserves valid neighbors when one result is indeterminate", async () => {
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

  test("returns deterministic forgotten for an empty artifact", async () => {
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
