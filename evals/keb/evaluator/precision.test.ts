import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { describe, expect, test } from "vitest";

import type { EvidenceCorpus } from "../core/types.js";
import { EvaluationError } from "../core/errors.js";
import {
  type PrecisionAssertionInventory,
  runPrecisionPass,
} from "./precision.js";
import {
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
} from "./prompts.js";
import type { ArtifactSection } from "./documents.js";

/**
 * Mutable direct-model test control.
 */
interface ModelControl {
  /**
   * Structured responses consumed in call order.
   */
  responses: unknown[];

  /**
   * System prompts observed in call order.
   */
  systemPrompts: string[];

  /**
   * Task prompts observed in call order.
   */
  taskPrompts: string[];
}

/**
 * Create a source-evidence corpus from concise source snippets.
 *
 * @param contents - Source content in stable record order.
 *
 * @returns Checkpoint evidence with deterministic identities.
 */
function evidence(contents: string[]): EvidenceCorpus {
  return {
    checkpointId: "T0",
    records: contents.map((content, index) => ({
      evidenceId: `source-${index.toString().padStart(2, "0")}::0000`,
      sourceRef: `source-${index.toString().padStart(2, "0")}.txt`,
      observedAtCheckpoint: "T0",
      current: true,
      content,
    })),
  };
}

/**
 * Create one stable Markdown artifact section.
 *
 * @param id - Stable section identity.
 * @param content - Section content.
 * @param headingPath - Optional heading hierarchy.
 *
 * @returns Artifact section suitable for precision evaluation.
 */
function section(
  id: string,
  content: string,
  headingPath: string[] = [],
): ArtifactSection {
  return {
    id,
    relativePath: "guide.md",
    headingPath,
    ordinal: 0,
    content,
    searchableText: content,
  };
}

/**
 * Create a queued structured-output model test double.
 *
 * @param control - Mutable response and prompt capture state.
 *
 * @returns Chat-model-shaped test double.
 */
function fakeModel(control: ModelControl): BaseChatModel {
  return {
    withStructuredOutput: () => ({
      invoke: async (messages: Array<{ content: string }>) => {
        control.systemPrompts.push(messages[0].content);
        control.taskPrompts.push(messages[1].content);
        return control.responses.shift();
      },
    }),
  } as unknown as BaseChatModel;
}

/**
 * Create model control with a fixed response queue.
 *
 * @param responses - Structured responses in invocation order.
 *
 * @returns Initialized model control.
 */
function controller(responses: unknown[]): ModelControl {
  return { responses: [...responses], systemPrompts: [], taskPrompts: [] };
}

describe("runPrecisionPass", () => {
  test("extracts a material claim and supports it from source evidence", async () => {
    const control = controller([
      {
        sections: [
          {
            sectionId: "guide::0000",
            assertions: ["The current version is 1.0.0."],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["source-00::0000"],
            rationale: "The source declares version 1.0.0.",
          },
        ],
      },
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections: [section("guide::0000", "Current release: 1.0.0.")],
      evidence: evidence(['export const VERSION = "1.0.0";']),
    });

    expect(evaluations).toEqual([
      {
        assertion: "The current version is 1.0.0.",
        location: "guide.md",
        verdict: "supported",
        evidenceIds: ["source-00::0000"],
        rationale: "The source declares version 1.0.0.",
      },
    ]);
    expect(control.systemPrompts).toEqual([
      PRECISION_EXTRACTION_SYSTEM,
      PRECISION_JUDGMENT_SYSTEM,
    ]);
  });

  test("keeps source contradictions distinct from uncertainty", async () => {
    const control = controller([
      {
        sections: [
          {
            sectionId: "guide::0000",
            assertions: [
              "The current version is 2.0.0.",
              "Addition is constant time.",
            ],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "contradicted",
            evidenceIds: ["source-00::0000"],
            rationale: "The source declares version 1.0.0.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "unverifiable",
            evidenceIds: [],
            rationale: "The source gives no complexity guarantee.",
          },
        ],
      },
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections: [section("guide::0000", "Version and performance.")],
      evidence: evidence(['export const VERSION = "1.0.0";']),
    });

    expect(evaluations.map((evaluation) => evaluation.verdict)).toEqual([
      "contradicted",
      "unverifiable",
    ]);
  });

  test("exhausts unretrieved evidence before finalizing unverifiable", async () => {
    const source = evidence([
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
      "eta",
      "theta",
      "42",
    ]);
    const control = controller([
      {
        sections: [
          {
            sectionId: "guide::0000",
            assertions: ["The answer is forty-two."],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "unverifiable",
            evidenceIds: [],
            rationale: "The supplied excerpts do not establish the date.",
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["source-08::0000"],
            rationale: "Fallback evidence establishes the answer.",
          },
        ],
      },
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections: [section("guide::0000", "The answer is forty-two.")],
      evidence: source,
    });

    expect(evaluations[0].verdict).toBe("supported");
    expect(control.systemPrompts).toHaveLength(3);
  });

  test("persists exclusions before semantic judgment", async () => {
    const control = controller([
      {
        sections: [
          {
            sectionId: "guide::0000",
            assertions: [
              "The current version is 1.0.0.",
              "The repository contains exactly three tracked files.",
              "Commit 0ee8f29 added subtract.",
            ],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["source-00::0000"],
            rationale: "The source establishes the version.",
          },
        ],
      },
    ]);
    let inventory: PrecisionAssertionInventory | undefined;

    await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections: [
        section("guide::0000", "Repository facts."),
        section("guide::0001", "Navigation.", ["Related pages"]),
      ],
      evidence: evidence(['export const VERSION = "1.0.0";']),
      onInventory: (value) => {
        inventory = value;
      },
    });

    expect(inventory).toMatchObject({
      totalSectionCount: 2,
      extractedSectionCount: 1,
      keptAssertionCount: 1,
    });
    expect(
      inventory?.candidates.map((candidate) => candidate.exclusionReason),
    ).toEqual([
      undefined,
      "repository-archaeology",
      "commit-history-assertion",
    ]);
    expect(inventory?.excludedSections[0].reason).toBe(
      "wiki-navigation-section",
    );
  });

  test("rejects citations unavailable to the assertion request", async () => {
    const invalid = {
      evaluations: [
        {
          assertionId: "assertion-000001",
          verdict: "supported",
          evidenceIds: ["invented::0000"],
          rationale: "Invented citation.",
        },
      ],
    };
    const control = controller([
      {
        sections: [
          { sectionId: "guide::0000", assertions: ["A material claim."] },
        ],
      },
      invalid,
      invalid,
    ]);

    await expect(
      runPrecisionPass({
        model: fakeModel(control),
        checkpointId: "T0",
        sections: [section("guide::0000", "A material claim.")],
        evidence: evidence(["source truth"]),
      }),
    ).rejects.toBeInstanceOf(EvaluationError);
  });

  test("returns unverifiable deterministically when no source evidence exists", async () => {
    const control = controller([
      {
        sections: [
          { sectionId: "guide::0000", assertions: ["A material claim."] },
        ],
      },
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections: [section("guide::0000", "A material claim.")],
      evidence: evidence([]),
    });

    expect(evaluations[0]).toMatchObject({
      verdict: "unverifiable",
      evidenceIds: [],
    });
    expect(control.systemPrompts).toEqual([PRECISION_EXTRACTION_SYSTEM]);
  });

  test("returns no judgments when extraction finds no material claims", async () => {
    const control = controller([
      {
        sections: [{ sectionId: "guide::0000", assertions: [] }],
      },
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections: [section("guide::0000", "See another page.")],
      evidence: evidence(["source truth"]),
    });

    expect(evaluations).toEqual([]);
    expect(control.systemPrompts).toEqual([PRECISION_EXTRACTION_SYSTEM]);
  });
});
