import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type {
  KebBenchmark,
  KebRunConfig,
  SystemRunOutcome,
  SystemUnderTest,
} from "../core/types.js";
import { wikiDirFor } from "../core/paths.js";
import { createTinyRepo, type TinyRepo } from "../testing/tiny-repo.js";

/**
 * Prompt and lifecycle telemetry captured by the scripted model.
 */
interface ScriptedModelControl {
  /**
   * System prompts observed in invocation order.
   */
  systemPrompts: string[];

  /**
   * User prompts observed in invocation order.
   */
  taskPrompts: string[];

  /**
   * Abort signals received by model invocations.
   */
  signals: AbortSignal[];

  /**
   * System prompt whose requests should hang until aborted.
   */
  hangingSystemPrompt?: string;

  /**
   * Number of invocations currently in flight.
   */
  active: number;

  /**
   * Highest simultaneous invocation count observed.
   */
  maxActive: number;
}

const modelControl = vi.hoisted<ScriptedModelControl>(() => ({
  systemPrompts: [],
  taskPrompts: [],
  signals: [],
  active: 0,
  maxActive: 0,
}));
const workspaceRoots = vi.hoisted(() => [] as string[]);

vi.mock("../../../src/agent/index.js", () => ({
  createModel: () => scriptedModel,
}));

vi.mock("../replay/workspace.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../replay/workspace.js")>();

  return {
    ...original,
    createWorkspace: async () => {
      const workspace = await original.createWorkspace();
      workspaceRoots.push(workspace.root);
      return workspace;
    },
  };
});

const {
  COVERAGE_SYSTEM,
  FORGETTING_SYSTEM,
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
} = await import("../evaluator/prompts.js");

/**
 * Parse JSON following a stable prompt marker.
 *
 * @param prompt - Prompt containing JSON data.
 * @param marker - Marker immediately preceding the JSON payload.
 * @param endMarker - Optional marker terminating the payload.
 *
 * @returns The parsed prompt value.
 */
function parsePromptJson<T>(
  prompt: string,
  marker: string,
  endMarker?: string,
): T {
  const start = prompt.indexOf(marker);

  if (start === -1) {
    throw new Error(`Missing prompt marker "${marker}".`);
  }

  const valueStart = start + marker.length;
  const end = endMarker ? prompt.indexOf(endMarker, valueStart) : prompt.length;

  if (end === -1) {
    throw new Error(`Missing prompt marker "${endMarker}".`);
  }

  return JSON.parse(prompt.slice(valueStart, end)) as T;
}

/**
 * Wait for an invocation's abort signal and then reject.
 *
 * @param signal - Evaluator request abort signal.
 *
 * @returns A promise that never resolves successfully.
 */
function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectAborted = (): void => reject(new Error("request aborted"));

    if (signal.aborted) {
      rejectAborted();
      return;
    }

    signal.addEventListener("abort", rejectAborted, { once: true });
  });
}

/**
 * Produce a schema-valid response from the system prompt and task payload.
 *
 * @param systemPrompt - Semantic pass instructions.
 * @param taskPrompt - Data-bearing task prompt.
 *
 * @returns A structured evaluator response.
 */
function scriptedResponse(systemPrompt: string, taskPrompt: string): unknown {
  if (systemPrompt === COVERAGE_SYSTEM) {
    const targets = parsePromptJson<
      Array<{
        factId: string;
        statement: string;
        excerpts: Array<{ sectionId: string; content: string }>;
      }>
    >(taskPrompt, "Targets (JSON):\n");

    return {
      evaluations: targets.map((target) => {
        const evidence = target.excerpts.find((excerpt) =>
          excerpt.content.includes(target.statement),
        );

        return {
          factId: target.factId,
          verdict: evidence ? "correct" : "missing",
          evidence: evidence ? [evidence.sectionId] : [],
          rationale: evidence ? "The statement is present." : "It is absent.",
        };
      }),
    };
  }

  if (systemPrompt === FORGETTING_SYSTEM) {
    const targets = parsePromptJson<
      Array<{
        factVersionId: string;
        obsoleteStatement: string;
        excerpts: Array<{ sectionId: string; content: string }>;
      }>
    >(taskPrompt, "Targets (JSON):\n");

    return {
      evaluations: targets.map((target) => {
        const evidence = target.excerpts.find((excerpt) =>
          excerpt.content.includes(target.obsoleteStatement),
        );

        return {
          factVersionId: target.factVersionId,
          verdict: evidence ? "lingering" : "forgotten",
          evidence: evidence ? [evidence.sectionId] : [],
          rationale: evidence ? "The old statement remains." : "It is absent.",
        };
      }),
    };
  }

  if (systemPrompt === PRECISION_EXTRACTION_SYSTEM) {
    const sections = parsePromptJson<
      Array<{ sectionId: string; content: string }>
    >(taskPrompt, "Sections (JSON):\n");

    return {
      sections: sections.map((section) => ({
        sectionId: section.sectionId,
        assertions: section.content
          .split("\n")
          .filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2)),
      })),
    };
  }

  if (systemPrompt === PRECISION_JUDGMENT_SYSTEM) {
    const evidenceMarker = "\n\nSource evidence (JSON):\n";
    const assertions = parsePromptJson<
      Array<{
        assertionId: string;
        statement: string;
        evidenceIds: string[];
      }>
    >(taskPrompt, "Assertions (JSON):\n", evidenceMarker);

    return {
      evaluations: assertions.map((assertion) => {
        const contradicted = assertion.statement.includes("magic");

        return {
          assertionId: assertion.assertionId,
          verdict: contradicted ? "contradicted" : "supported",
          evidenceIds: [assertion.evidenceIds[0]],
          rationale: contradicted
            ? "The source contradicts it."
            : "The source supports it.",
        };
      }),
    };
  }

  throw new Error("Unknown evaluator system prompt.");
}

const scriptedModel = {
  withStructuredOutput: () => ({
    invoke: async (
      messages: Array<{ role: string; content: string }>,
      options: { signal: AbortSignal },
    ) => {
      const systemPrompt = messages[0].content;
      const taskPrompt = messages[1].content;
      modelControl.systemPrompts.push(systemPrompt);
      modelControl.taskPrompts.push(taskPrompt);
      modelControl.signals.push(options.signal);
      modelControl.active += 1;
      modelControl.maxActive = Math.max(
        modelControl.maxActive,
        modelControl.active,
      );

      try {
        if (systemPrompt === modelControl.hangingSystemPrompt) {
          return await hangUntilAborted(options.signal);
        }

        await Promise.resolve();
        return scriptedResponse(systemPrompt, taskPrompt);
      } finally {
        modelControl.active -= 1;
      }
    },
  }),
} as unknown as BaseChatModel;

const { ModelEvaluationBackend } =
  await import("../evaluator/model-backend.js");
const { formatReport } = await import("./report.js");
const { runBenchmark } = await import("./runner.js");
const { writeRunResult } = await import("./persistence.js");

/**
 * Documentation system that evolves one Markdown artifact over three runs.
 */
class EvolvingDocumentationSystem implements SystemUnderTest {
  readonly name = "evolving-fixture";

  private updateIndex = 0;

  /**
   * Write the initial artifact.
   *
   * @param worktreeDir - Prepared benchmark worktree.
   *
   * @returns Deterministic run metadata.
   */
  async init(worktreeDir: string): Promise<SystemRunOutcome> {
    await this.write(
      worktreeDir,
      "- Stable behavior is enabled.\n- Changed behavior uses version one.\n- Removed behavior is available.\n- Undocumented magic is available.\n",
    );
    return { skipped: false, durationMs: 1 };
  }

  /**
   * Write the next deterministic artifact version.
   *
   * @param worktreeDir - Prepared benchmark worktree.
   *
   * @returns Deterministic run metadata.
   */
  async update(worktreeDir: string): Promise<SystemRunOutcome> {
    this.updateIndex += 1;
    const content =
      this.updateIndex === 1
        ? "- Stable behavior is enabled.\n- Introduced behavior is enabled.\n- Changed behavior uses version one.\n- Removed behavior is available.\n- Undocumented magic is available.\n"
        : "- Stable behavior is enabled.\n- Introduced behavior is enabled.\n- Changed behavior uses version two.\n- Undocumented magic is available.\n";

    await this.write(worktreeDir, content);
    return { skipped: false, durationMs: 1 };
  }

  /**
   * Persist one Markdown artifact in the generated wiki directory.
   *
   * @param worktreeDir - Prepared benchmark worktree.
   * @param content - Exact Markdown body to write.
   *
   * @returns Nothing after the artifact is written.
   */
  private async write(worktreeDir: string, content: string): Promise<void> {
    const destination = path.join(wikiDirFor(worktreeDir), "knowledge.md");
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `# Knowledge\n\n${content}`, "utf8");
  }
}

/**
 * Build the three-checkpoint Truth Package used by the end-to-end test.
 *
 * @param repo - Tiny repository supplying checkpoint commits.
 *
 * @returns A complete benchmark fixture.
 */
function benchmark(repo: TinyRepo): KebBenchmark {
  return {
    name: "direct-evaluator-e2e",
    description: "Complete deterministic evaluator pipeline",
    sourceRepoPath: repo.repoPath,
    trace: {
      checkpoints: repo.shas.map((commit, index) => ({
        id: `T${index}`,
        commit,
      })),
    },
    truthPackage: {
      requirements: [
        {
          id: "stable",
          versions: [
            { statement: "Stable behavior is enabled.", fromCheckpoint: "T0" },
          ],
        },
        {
          id: "introduced",
          versions: [
            {
              statement: "Introduced behavior is enabled.",
              fromCheckpoint: "T1",
            },
          ],
        },
        {
          id: "changed",
          versions: [
            {
              statement: "Changed behavior uses version one.",
              fromCheckpoint: "T0",
              untilCheckpoint: "T2",
            },
            {
              statement: "Changed behavior uses version two.",
              fromCheckpoint: "T2",
            },
          ],
        },
        {
          id: "removed",
          versions: [
            {
              statement: "Removed behavior is available.",
              fromCheckpoint: "T0",
              untilCheckpoint: "T2",
            },
          ],
        },
      ],
    },
  };
}

/**
 * Build deterministic runner configuration.
 *
 * @param resultsDir - Directory used for persisted test results.
 *
 * @returns Resolved run configuration.
 */
function config(resultsDir: string): KebRunConfig {
  return {
    benchmarkDir: "/fixture",
    provider: "anthropic",
    evaluatorModelId: "scripted-model",
    resultsDir,
  };
}

let repo: TinyRepo;
let resultsDir: string;

beforeEach(async () => {
  repo = await createTinyRepo([
    { message: "T0", files: { "code.ts": "export const version = 0;\n" } },
    { message: "T1", files: { "code.ts": "export const version = 1;\n" } },
    { message: "T2", files: { "code.ts": "export const version = 2;\n" } },
  ]);
  resultsDir = await mkdtemp(path.join(os.tmpdir(), "keb-results-"));
  modelControl.systemPrompts.length = 0;
  modelControl.taskPrompts.length = 0;
  modelControl.signals.length = 0;
  modelControl.hangingSystemPrompt = undefined;
  modelControl.active = 0;
  modelControl.maxActive = 0;
  workspaceRoots.length = 0;
});

afterEach(async () => {
  await repo.dispose();
  await rm(resultsDir, { recursive: true, force: true });
});

describe("direct evaluator end to end", () => {
  test("replays, evaluates, scores, persists, and reports deterministically", async () => {
    const result = await runBenchmark({
      benchmark: benchmark(repo),
      system: new EvolvingDocumentationSystem(),
      evaluationBackend: new ModelEvaluationBackend({
        provider: "anthropic",
        modelId: "scripted-model",
        timeoutMs: 1_000,
      }),
      config: config(resultsDir),
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(result.checkpoints.map((checkpoint) => checkpoint.coverage)).toEqual(
      [
        {
          correct: 3,
          partial: 0,
          missing: 0,
          contradicted: 0,
          total: 3,
          score: 1,
        },
        {
          correct: 4,
          partial: 0,
          missing: 0,
          contradicted: 0,
          total: 4,
          score: 1,
        },
        {
          correct: 3,
          partial: 0,
          missing: 0,
          contradicted: 0,
          total: 3,
          score: 1,
        },
      ],
    );
    expect(
      result.checkpoints.map((checkpoint) => checkpoint.precision),
    ).toEqual([
      {
        supported: 3,
        contradicted: 1,
        unverifiable: 0,
        decidable: 4,
        total: 4,
        hallucinationRate: 0.25,
        unverifiableRate: 0,
        score: 0.75,
      },
      {
        supported: 4,
        contradicted: 1,
        unverifiable: 0,
        decidable: 5,
        total: 5,
        hallucinationRate: 0.2,
        unverifiableRate: 0,
        score: 0.8,
      },
      {
        supported: 3,
        contradicted: 1,
        unverifiable: 0,
        decidable: 4,
        total: 4,
        hallucinationRate: 0.25,
        unverifiableRate: 0,
        score: 0.75,
      },
    ]);
    expect(result.score.maintenanceRates).toEqual({
      newKnowledgeDiscovery: 1,
      changedKnowledgeCorrection: 1,
      completeForgetting: 1,
      stableRetention: 1,
    });
    expect(
      result.checkpoints.flatMap(
        (checkpoint) =>
          checkpoint.evaluations?.precisionEvaluations.filter(
            (evaluation) => evaluation.verdict === "contradicted",
          ) ?? [],
      ),
    ).toEqual([
      expect.objectContaining({
        assertion: "Undocumented magic is available.",
      }),
      expect.objectContaining({
        assertion: "Undocumented magic is available.",
      }),
      expect.objectContaining({
        assertion: "Undocumented magic is available.",
      }),
    ]);
    expect(result.checkpoints[2].evaluations?.forgettingEvaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          factVersionId: "changed@T0",
          verdict: "forgotten",
        }),
        expect.objectContaining({
          factVersionId: "removed@T0",
          verdict: "forgotten",
        }),
      ]),
    );
    expect(modelControl.systemPrompts).toEqual([
      COVERAGE_SYSTEM,
      PRECISION_EXTRACTION_SYSTEM,
      PRECISION_JUDGMENT_SYSTEM,
      COVERAGE_SYSTEM,
      PRECISION_EXTRACTION_SYSTEM,
      PRECISION_JUDGMENT_SYSTEM,
      COVERAGE_SYSTEM,
      FORGETTING_SYSTEM,
      PRECISION_EXTRACTION_SYSTEM,
      PRECISION_JUDGMENT_SYSTEM,
    ]);
    expect(modelControl.maxActive).toBe(1);
    expect(modelControl.signals).toHaveLength(10);
    expect(workspaceRoots).toHaveLength(1);
    await expect(stat(workspaceRoots[0])).rejects.toMatchObject({
      code: "ENOENT",
    });

    const runDir = await writeRunResult(resultsDir, result);
    const persisted = JSON.parse(
      await readFile(path.join(runDir, "result.json"), "utf8"),
    ) as { metadata: Record<string, unknown> };
    expect(persisted.metadata).not.toHaveProperty("evaluatorPromptVersion");
    expect(formatReport(result)).toContain("Contradicted assertions (1 of 4)");
  });

  test("times out, stops later passes, and cleans replay resources", async () => {
    modelControl.hangingSystemPrompt = COVERAGE_SYSTEM;
    const backend = new ModelEvaluationBackend({
      provider: "anthropic",
      modelId: "scripted-model",
      timeoutMs: 10,
    });

    await expect(
      runBenchmark({
        benchmark: benchmark(repo),
        system: new EvolvingDocumentationSystem(),
        evaluationBackend: backend,
        config: config(resultsDir),
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(
      /checkpoint "T0" pass "coverage" failed after 2 attempts/u,
    );

    expect(modelControl.systemPrompts).toEqual([
      COVERAGE_SYSTEM,
      COVERAGE_SYSTEM,
    ]);
    expect(modelControl.signals.every((signal) => signal.aborted)).toBe(true);
    expect(workspaceRoots).toHaveLength(1);
    await expect(stat(workspaceRoots[0])).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
