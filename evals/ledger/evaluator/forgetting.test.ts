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
            matchedText: "other 0",
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
    expect(evaluation.matchedText).toBe("other 0");
    expect(control.taskPrompts).toHaveLength(2);
  });

  test("requires a verbatim quote from cited evidence for lingering", async () => {
    const invalid = {
      evaluations: [
        {
          factVersionId: "enqueue@T0",
          verdict: "lingering",
          evidence: ["seen"],
          matchedText: "enqueue(queue, task)",
          rationale: "The obsolete signature remains current.",
        },
      ],
    };
    const control = controller([invalid, invalid, invalid]);
    const warnings: string[] = [];

    const [evaluation] = await runForgettingPass({
      model: fakeModel(control),
      checkpointId: "T1",
      obsoleteFacts: [
        obsoleteFact("enqueue", "enqueue(queue, task) accepts a task."),
      ],
      index: new SectionBm25Index([
        section("seen", "Call enqueue(queue, task, priority) to add a task."),
      ]),
      onWarning: (warning) => warnings.push(warning.message),
    });

    expect(evaluation.verdict).toBe("indeterminate");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      "matchedText does not appear verbatim in cited evidence",
    );
  });

  test("rejects lingering without matched text", async () => {
    const invalid = {
      evaluations: [
        {
          factVersionId: "old@T0",
          verdict: "lingering",
          evidence: ["seen"],
          rationale: "The same name appears.",
        },
      ],
    };
    const control = controller([invalid, invalid, invalid]);

    const [evaluation] = await runForgettingPass({
      model: fakeModel(control),
      checkpointId: "T1",
      obsoleteFacts: [obsoleteFact("old", "old() has no parameters.")],
      index: new SectionBm25Index([section("seen", "Use old(value).")]),
    });

    expect(evaluation.verdict).toBe("indeterminate");
  });

  test("rejects matched text on a forgotten verdict", async () => {
    const invalid = {
      evaluations: [
        {
          factVersionId: "old@T0",
          verdict: "forgotten",
          evidence: ["history"],
          matchedText: "old() was removed.",
          rationale: "The excerpt describes removal.",
        },
      ],
    };
    const control = controller([invalid, invalid, invalid]);

    const [evaluation] = await runForgettingPass({
      model: fakeModel(control),
      checkpointId: "T1",
      obsoleteFacts: [obsoleteFact("old", "old() exists.")],
      index: new SectionBm25Index([section("history", "old() was removed.")]),
    });

    expect(evaluation.verdict).toBe("indeterminate");
  });

  test("defines exact-version boundaries in the classifier prompt", () => {
    expect(FORGETTING_SYSTEM).toContain("exact obsolete fact version");
    expect(FORGETTING_SYSTEM).toContain(
      "A generic mention of the same name is insufficient",
    );
    expect(FORGETTING_SYSTEM).toContain(
      "artifact page does not assert that a similarly named",
    );
    expect(FORGETTING_SYSTEM).toContain(
      "source file currently exists unless the excerpt says so",
    );
    expect(FORGETTING_SYSTEM).toContain(
      "replacement signature, behavior, meaning, or source path",
    );
    expect(FORGETTING_SYSTEM).toContain(
      "example that remains valid under both the obsolete and current versions",
    );
    expect(FORGETTING_SYSTEM).toContain(
      "statement, including every version-distinguishing parameter, default, return",
    );
    expect(FORGETTING_SYSTEM).toContain('the verdict must be "forgotten"');
    expect(FORGETTING_SYSTEM).toContain("matchedText: the smallest");
    expect(FORGETTING_SYSTEM).toContain(
      "exact verbatim span from a cited excerpt",
    );
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
          matchedText: "old truth",
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
          matchedText: "old truth",
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
