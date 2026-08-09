import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { describe, expect, test } from "vitest";

import { EvaluationError } from "../core/errors.js";
import type { ActiveTruthFact } from "../core/types.js";
import type { ArtifactSection } from "./documents.js";
import {
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
} from "./prompts.js";
import {
  runPrecisionPass,
  type PrecisionAssertionInventory,
} from "./precision.js";

/**
 * Queued responses and invocation telemetry for precision tests.
 */
interface ModelController {
  /**
   * Structured values or errors consumed in invocation order.
   */
  responses: Array<unknown | Error>;

  /**
   * System prompts received in invocation order.
   */
  systemPrompts: string[];

  /**
   * User prompts received in invocation order.
   */
  taskPrompts: string[];

  /**
   * Number of invocations currently awaiting their response.
   */
  active: number;

  /**
   * Highest observed simultaneous invocation count.
   */
  maxActive: number;
}

/**
 * Build a complete artifact-section fixture.
 *
 * @param id - Stable section identifier.
 * @param relativePath - Wiki path owning the section.
 * @param content - Markdown section content.
 *
 * @returns Artifact section fixture.
 */
function section(
  id: string,
  relativePath: string,
  content: string,
): ArtifactSection {
  return {
    id,
    relativePath,
    headingPath: [id],
    ordinal: 0,
    content,
    searchableText: content,
  };
}

/**
 * Build an active Truth Ledger fact fixture.
 *
 * @param factId - Stable fact identifier.
 * @param statement - Current fact statement.
 *
 * @returns Active fact fixture.
 */
function activeFact(factId: string, statement: string): ActiveTruthFact {
  return {
    factId,
    factVersionId: `${factId}@T0`,
    category: "test",
    statement,
  };
}

/**
 * Create fresh model-control state.
 *
 * @param responses - Structured values or errors returned in order.
 *
 * @returns Mutable test controller.
 */
function controller(responses: Array<unknown | Error>): ModelController {
  return {
    responses,
    systemPrompts: [],
    taskPrompts: [],
    active: 0,
    maxActive: 0,
  };
}

/**
 * Build the direct structured-output model surface used by precision.
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
 * Parse the section array from an extraction prompt.
 *
 * @param prompt - Precision extraction task prompt.
 *
 * @returns Parsed section records.
 */
function extractionSections(prompt: string): Array<Record<string, unknown>> {
  const marker = "Sections (JSON):\n";
  const offset = prompt.indexOf(marker);

  if (offset === -1) {
    throw new Error("Extraction prompt has no sections marker.");
  }

  return JSON.parse(prompt.slice(offset + marker.length)) as Array<
    Record<string, unknown>
  >;
}

/**
 * Parse assertions and the complete ledger from a judgment prompt.
 *
 * @param prompt - Precision judgment task prompt.
 *
 * @returns Parsed assertion and ledger arrays.
 */
function judgmentPayload(prompt: string): {
  assertions: Array<Record<string, unknown>>;
  activeFacts: Array<Record<string, unknown>>;
} {
  const assertionMarker = "Assertions (JSON):\n";
  const ledgerMarker = "\n\nComplete active Truth Ledger (JSON):\n";
  const assertionOffset = prompt.indexOf(assertionMarker);
  const ledgerOffset = prompt.indexOf(ledgerMarker);

  if (assertionOffset === -1 || ledgerOffset === -1) {
    throw new Error("Judgment prompt has incomplete JSON markers.");
  }

  return {
    assertions: JSON.parse(
      prompt.slice(assertionOffset + assertionMarker.length, ledgerOffset),
    ) as Array<Record<string, unknown>>,
    activeFacts: JSON.parse(
      prompt.slice(ledgerOffset + ledgerMarker.length),
    ) as Array<Record<string, unknown>>,
  };
}

describe("runPrecisionPass", () => {
  test("exhaustively extracts in stable batches, deduplicates, and judges in stable order", async () => {
    const sections = [
      section("c::0000", "c.md", "Gamma behavior."),
      section("a::0000", "a.md", "Shared and alpha behavior."),
      section("b::0000", "b.md", "Shared and beta behavior."),
    ];
    const facts = [
      activeFact("shared", "Shared fact."),
      activeFact("alpha", "Alpha behavior."),
      activeFact("beta", "Beta behavior."),
    ];
    const control = controller([
      {
        sections: [
          {
            sectionId: "b::0000",
            assertions: ["Shared fact", "Beta behavior."],
          },
          {
            sectionId: "a::0000",
            assertions: ["Shared fact.", "Alpha   behavior!"],
          },
        ],
      },
      {
        sections: [{ sectionId: "c::0000", assertions: ["Gamma behavior."] }],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000002",
            verdict: "supported",
            supportingFactIds: ["alpha"],
            rationale: "Alpha is in the ledger.",
          },
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            supportingFactIds: ["shared"],
            rationale: "Shared is in the ledger.",
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000004",
            verdict: "unsupported",
            supportingFactIds: [],
            rationale: "The ledger is silent about gamma.",
          },
          {
            assertionId: "assertion-000003",
            verdict: "supported",
            supportingFactIds: ["beta"],
            rationale: "Beta is in the ledger.",
          },
        ],
      },
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections,
      activeFacts: facts,
      extractionBatchSize: 2,
      judgmentBatchSize: 2,
    });

    expect(evaluations).toEqual([
      expect.objectContaining({
        assertion: "Shared fact.",
        location: "a.md",
        verdict: "supported",
      }),
      expect.objectContaining({
        assertion: "Alpha behavior!",
        location: "a.md",
        verdict: "supported",
      }),
      expect.objectContaining({
        assertion: "Beta behavior.",
        location: "b.md",
        verdict: "supported",
      }),
      expect.objectContaining({
        assertion: "Gamma behavior.",
        location: "c.md",
        verdict: "unsupported",
        supportingFactIds: [],
      }),
    ]);
    expect(control.taskPrompts).toHaveLength(4);
    expect(control.maxActive).toBe(1);

    const extractedSectionIds = control.taskPrompts
      .slice(0, 2)
      .flatMap((prompt) =>
        extractionSections(prompt).map((item) => item.sectionId),
      );
    expect(extractedSectionIds).toEqual(["a::0000", "b::0000", "c::0000"]);

    for (const prompt of control.taskPrompts.slice(2)) {
      expect(judgmentPayload(prompt).activeFacts).toEqual(
        facts.map((fact) => ({
          factId: fact.factId,
          statement: fact.statement,
        })),
      );
    }
    expect(
      judgmentPayload(control.taskPrompts[2]).assertions.map(
        (assertion) => assertion.assertionId,
      ),
    ).toEqual(["assertion-000001", "assertion-000002"]);
  });

  test("retries then rejects incomplete extraction output", async () => {
    const incomplete = {
      sections: [{ sectionId: "a::0000", assertions: ["A fact."] }],
    };
    const control = controller([incomplete, incomplete]);

    await expect(
      runPrecisionPass({
        model: fakeModel(control),
        checkpointId: "T0",
        sections: [
          section("a::0000", "a.md", "A fact."),
          section("b::0000", "b.md", "B fact."),
        ],
        activeFacts: [],
      }),
    ).rejects.toBeInstanceOf(EvaluationError);
    expect(control.taskPrompts).toHaveLength(2);
  });

  test("treats ledger silence as unsupported and accepts no support IDs", async () => {
    const control = controller([
      {
        sections: [
          { sectionId: "a::0000", assertions: ["Undocumented truth."] },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "unsupported",
            supportingFactIds: [],
            rationale: "The complete ledger is silent.",
          },
        ],
      },
    ]);

    const [evaluation] = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections: [section("a::0000", "a.md", "Undocumented truth.")],
      activeFacts: [activeFact("different", "A different fact.")],
    });

    expect(evaluation.verdict).toBe("unsupported");
    expect(PRECISION_JUDGMENT_SYSTEM).toContain(
      'Ledger silence is "unsupported"',
    );
    expect(control.systemPrompts).toEqual([
      PRECISION_EXTRACTION_SYSTEM,
      PRECISION_JUDGMENT_SYSTEM,
    ]);
    expect(control.systemPrompts.join("\n")).not.toContain("read_file");
  });

  test("does not semantically deduplicate differently worded assertions", async () => {
    const control = controller([
      {
        sections: [
          {
            sectionId: "a::0000",
            assertions: ["Retries occur.", "Requests are retried."],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "unsupported",
            supportingFactIds: [],
            rationale: "The ledger is silent.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "unsupported",
            supportingFactIds: [],
            rationale: "The ledger is silent.",
          },
        ],
      },
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections: [section("a::0000", "a.md", "Retry prose.")],
      activeFacts: [],
    });

    expect(evaluations.map((evaluation) => evaluation.assertion)).toEqual([
      "Retries occur.",
      "Requests are retried.",
    ]);
  });

  test("deterministically deduplicates equivalent repository-absence claims", async () => {
    const control = controller([
      {
        sections: [
          {
            sectionId: "a::0000",
            assertions: [
              "No test files exist in the repository.",
              "There are no tests anywhere in the tree.",
              "There is no test runner configuration.",
            ],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            supportingFactIds: ["tests"],
            rationale: "The repository has no tests.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "supported",
            supportingFactIds: ["runner"],
            rationale: "The repository has no test runner.",
          },
        ],
      },
    ]);
    let inventory: PrecisionAssertionInventory | undefined;

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections: [section("a::0000", "a.md", "Repository testing state.")],
      activeFacts: [
        activeFact("tests", "The repository has no tests."),
        activeFact("runner", "The repository has no test runner."),
      ],
      onInventory: (value) => {
        inventory = value;
      },
    });

    expect(evaluations).toHaveLength(2);
    expect(inventory?.candidates[1]).toMatchObject({
      disposition: "excluded",
      exclusionReason: "semantic-duplicate",
      duplicateOf: "assertion-000001",
    });
  });

  test("excludes advice and hypothetical change scenarios", async () => {
    const control = controller([
      {
        sections: [
          {
            sectionId: "a::0000",
            assertions: [
              "Contributors should update README.md when adding an export.",
              "If VERSION were changed, the README would become stale.",
              "The library exports add.",
              "The service must run Redis.",
            ],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            supportingFactIds: ["add"],
            rationale: "Supported.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "supported",
            supportingFactIds: ["redis"],
            rationale: "Supported.",
          },
        ],
      },
    ]);
    let inventory: PrecisionAssertionInventory | undefined;

    await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections: [section("a::0000", "a.md", "Guidance and facts.")],
      activeFacts: [
        activeFact("add", "The library exports add."),
        activeFact("redis", "The service must run Redis."),
      ],
      onInventory: (value) => {
        inventory = value;
      },
    });

    expect(
      inventory?.candidates.map((candidate) => candidate.exclusionReason),
    ).toEqual([
      "prescriptive-assertion",
      "hypothetical-assertion",
      undefined,
      undefined,
    ]);
  });

  test("persists an auditable filtered inventory before judgment", async () => {
    const contentSection = section(
      "guide::0000",
      "guide.md",
      "Current repository facts.",
    );
    const navigationSection = {
      ...section("guide::0001", "guide.md", "Page routing."),
      headingPath: ["Documentation map"],
    };
    const control = controller([
      {
        sections: [
          {
            sectionId: "guide::0000",
            assertions: [
              "The library exports add.",
              "The library exports add!",
              "The wiki page API Reference covers add.",
              "Commit 0ee8f29 did not touch version.ts.",
              "calc is a minimal, well-behaved codebase rather than a production library.",
              "The add function returns the sum of two numbers.",
              "The add function returns the sum of its two numbers.",
            ],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            supportingFactIds: ["add"],
            rationale: "Supported.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "supported",
            supportingFactIds: ["add"],
            rationale: "Supported.",
          },
          {
            assertionId: "assertion-000003",
            verdict: "supported",
            supportingFactIds: ["add"],
            rationale: "Supported.",
          },
        ],
      },
    ]);
    let inventory: PrecisionAssertionInventory | undefined;
    let callsAtInventory = -1;

    const result = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [navigationSection, contentSection],
      activeFacts: [activeFact("add", "The library exports add.")],
      onInventory: (value) => {
        inventory = value;
        callsAtInventory = control.systemPrompts.length;
      },
    });

    expect(callsAtInventory).toBe(1);
    expect(control.systemPrompts).toEqual([
      PRECISION_EXTRACTION_SYSTEM,
      PRECISION_JUDGMENT_SYSTEM,
    ]);
    expect(extractionSections(control.taskPrompts[0])).toEqual([
      expect.objectContaining({ sectionId: "guide::0000" }),
    ]);
    expect(inventory).toMatchObject({
      checkpointId: "T1",
      totalSectionCount: 2,
      extractedSectionCount: 1,
      keptAssertionCount: 3,
      excludedSections: [
        expect.objectContaining({
          sectionId: "guide::0001",
          reason: "wiki-navigation-section",
        }),
      ],
    });
    expect(
      inventory?.candidates.map((candidate) => candidate.exclusionReason),
    ).toEqual([
      undefined,
      "exact-duplicate",
      "wiki-meta-assertion",
      "commit-history-assertion",
      "editorial-assertion",
      undefined,
      undefined,
    ]);
    expect(inventory?.nearDuplicatePairs).toEqual([
      expect.objectContaining({
        firstAssertionId: "assertion-000002",
        secondAssertionId: "assertion-000003",
      }),
    ]);
    expect(result).toHaveLength(3);
  });

  test("retries then rejects unknown supporting fact IDs", async () => {
    const extraction = {
      sections: [{ sectionId: "a::0000", assertions: ["A fact."] }],
    };
    const invalidJudgment = {
      evaluations: [
        {
          assertionId: "assertion-000001",
          verdict: "supported",
          supportingFactIds: ["unknown"],
          rationale: "Invented support.",
        },
      ],
    };
    const control = controller([extraction, invalidJudgment, invalidJudgment]);

    await expect(
      runPrecisionPass({
        model: fakeModel(control),
        checkpointId: "T0",
        sections: [section("a::0000", "a.md", "A fact.")],
        activeFacts: [activeFact("known", "A fact.")],
      }),
    ).rejects.toBeInstanceOf(EvaluationError);
    expect(control.taskPrompts).toHaveLength(3);
  });

  test("rejects incomplete and verdict-inconsistent judgment output", async () => {
    const invalidJudgments = [
      {
        evaluations: [],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            supportingFactIds: [],
            rationale: "No support supplied.",
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "unsupported",
            supportingFactIds: ["known"],
            rationale: "Support conflicts with verdict.",
          },
        ],
      },
    ];

    for (const invalidJudgment of invalidJudgments) {
      const extraction = {
        sections: [{ sectionId: "a::0000", assertions: ["A fact."] }],
      };
      const control = controller([
        extraction,
        invalidJudgment,
        invalidJudgment,
      ]);

      await expect(
        runPrecisionPass({
          model: fakeModel(control),
          checkpointId: "T0",
          sections: [section("a::0000", "a.md", "A fact.")],
          activeFacts: [activeFact("known", "A fact.")],
        }),
      ).rejects.toBeInstanceOf(EvaluationError);
      expect(control.taskPrompts).toHaveLength(3);
    }
  });

  test("returns empty after exhaustive extraction finds no assertions", async () => {
    const control = controller([
      {
        sections: [
          { sectionId: "a::0000", assertions: [] },
          { sectionId: "b::0000", assertions: [] },
        ],
      },
    ]);

    const result = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections: [
        section("b::0000", "b.md", "# Navigation"),
        section("a::0000", "a.md", "# Overview"),
      ],
      activeFacts: [],
    });

    expect(result).toEqual([]);
    expect(control.taskPrompts).toHaveLength(1);
  });

  test("returns empty without a model call when there are no sections", async () => {
    const control = controller([]);

    await expect(
      runPrecisionPass({
        model: fakeModel(control),
        checkpointId: "T0",
        sections: [],
        activeFacts: [],
      }),
    ).resolves.toEqual([]);
    expect(control.taskPrompts).toEqual([]);
  });

  test("rejects duplicate section IDs before invoking the model", async () => {
    const control = controller([]);

    await expect(
      runPrecisionPass({
        model: fakeModel(control),
        checkpointId: "T0",
        sections: [
          section("same", "a.md", "A."),
          section("same", "b.md", "B."),
        ],
        activeFacts: [],
      }),
    ).rejects.toThrow(/duplicate artifact section IDs/u);
    expect(control.taskPrompts).toEqual([]);
  });

  test.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid extraction batch size %s before invoking the model",
    async (extractionBatchSize) => {
      const control = controller([]);

      await expect(
        runPrecisionPass({
          model: fakeModel(control),
          checkpointId: "T0",
          sections: [section("a", "a.md", "A fact.")],
          activeFacts: [],
          extractionBatchSize,
        }),
      ).rejects.toThrow(/positive integer/u);
      expect(control.taskPrompts).toEqual([]);
    },
  );
});
