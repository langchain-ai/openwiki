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
  LedgerBenchmark,
  LedgerRunConfig,
  LedgerRunResult,
  SystemRunOutcome,
  SystemUnderTest,
} from "../core/types.js";
import { wikiDirFor } from "../core/paths.js";
import { extractSurface } from "../benchmark/surface.js";
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
  FORGETTING_SYSTEM,
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_HISTORY_JUDGMENT_SYSTEM,
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
          matchedText: evidence ? target.obsoleteStatement : undefined,
          rationale: evidence ? "The old statement remains." : "It is absent.",
        };
      }),
    };
  }

  if (systemPrompt === PRECISION_EXTRACTION_SYSTEM) {
    const units = parsePromptJson<Array<{ unitId: string; content: string }>>(
      taskPrompt,
      "Text units (JSON):\n",
    );

    return {
      units: units.map((unit) => {
        const assertions = unit.content
          .split("\n")
          .filter((line) => line.startsWith("- "))
          .map((line) => ({
            statement: line.slice(2),
            sourceQuote: line.slice(2),
            tense: "current",
          }));

        return {
          unitId: unit.unitId,
          classification: assertions.length > 0 ? "factual" : "no-claim",
          assertions,
          rationale:
            assertions.length > 0
              ? "The unit states factual behavior."
              : "The unit contains no factual claim.",
        };
      }),
    };
  }

  if (systemPrompt === PRECISION_JUDGMENT_SYSTEM) {
    const artifactMarker = "\n\nArtifact contexts (JSON):\n";
    const evidenceMarker = "\n\nSource evidence (JSON):\n";
    const assertions = parsePromptJson<
      Array<{
        assertionId: string;
        statement: string;
        evidenceIds: string[];
      }>
    >(taskPrompt, "Assertions (JSON):\n", artifactMarker);
    const sourceEvidence = parsePromptJson<
      Array<{ evidenceId: string; current: boolean }>
    >(taskPrompt, evidenceMarker);
    const currentEvidenceId = sourceEvidence.find(
      (item) => item.current,
    )?.evidenceId;

    if (currentEvidenceId === undefined) {
      throw new Error("Scripted grounding requires a current evidence record.");
    }

    // Ground every claim against source: the "magic" bullet has no source
    // support and is a current-state contradiction (invented); every other claim
    // is established by the current source and is supported. The shared batch
    // evidence always includes the current record, so both verdicts cite it.
    return {
      evaluations: assertions.map((assertion) => {
        const contradicted = assertion.statement.includes("magic");

        return {
          assertionId: assertion.assertionId,
          verdict: contradicted ? "contradicted" : "supported",
          evidenceIds: [currentEvidenceId],
          formerlyTrue: contradicted ? false : undefined,
          rationale: contradicted
            ? "The current source establishes incompatible behavior."
            : "The current source establishes the claim.",
        };
      }),
    };
  }

  if (systemPrompt === PRECISION_HISTORY_JUDGMENT_SYSTEM) {
    const artifactMarker = "\n\nArtifact contexts (JSON):\n";
    const evidenceMarker = "\n\nSource evidence (JSON):\n";
    const assertions = parsePromptJson<
      Array<{ assertionId: string; statement: string }>
    >(taskPrompt, "Assertions (JSON):\n", artifactMarker);

    return {
      evaluations: assertions.map((assertion) => ({
        assertionId: assertion.assertionId,
        verdict: "not-addressed",
        evidenceIds: [],
        rationale: "Historical source never establishes undocumented magic.",
      })),
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
 * Build the three-checkpoint benchmark used by the end-to-end test. Truth comes
 * entirely from the source repo's evolving surface, so this minimal benchmark is the
 * repo history plus named checkpoints.
 *
 * @param repo - Tiny repository supplying checkpoint commits.
 *
 * @returns A complete benchmark fixture.
 */
function benchmark(repo: TinyRepo): LedgerBenchmark {
  return {
    name: "direct-evaluator-e2e",
    description: "Complete deterministic evaluator pipeline",
    difficulty: "medium",
    sourceRepoPath: repo.repoPath,
    trace: {
      checkpoints: repo.shas.map((commit, index) => ({
        id: `T${index}`,
        commit,
      })),
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
function config(resultsDir: string): LedgerRunConfig {
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
  // The source surface evolves across the three checkpoints so the diff exercises
  // every transition bucket: `stable` never changes; `introduced` appears at T1;
  // `changed` keeps its signature until T2, where its parameter list grows; and
  // `removed` disappears at T2. The exported names deliberately share terms with
  // the artifact's prose bullets so BM25 retrieves current source evidence for
  // grounding. No `VERSION` constant or `package.json`, so there is no version
  // surface item.
  const stable = "export function stable(): number {\n  return 0;\n}\n";
  const introduced = "export function introduced(): number {\n  return 0;\n}\n";
  const changedV1 =
    "export function changed(a: number): number {\n  return a;\n}\n";
  const changedV2 =
    "export function changed(a: number, b: number): number {\n  return a + b;\n}\n";
  const removed = "export function removed(): number {\n  return 0;\n}\n";
  repo = await createTinyRepo([
    {
      message: "T0",
      files: { "code.ts": `${stable}\n${changedV1}\n${removed}` },
    },
    {
      message: "T1",
      files: {
        "code.ts": `${stable}\n${introduced}\n${changedV1}\n${removed}`,
      },
    },
    {
      message: "T2",
      files: { "code.ts": `${stable}\n${introduced}\n${changedV2}` },
    },
  ]);
  resultsDir = await mkdtemp(path.join(os.tmpdir(), "ledger-results-"));
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
  test("replays, evaluates, persists, and reports deterministically", async () => {
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

    expect(result.checkpoints.map((checkpoint) => checkpoint.claims)).toEqual([
      {
        supported: 3,
        invented: 1,
        stale: 0,
        unverified: 0,
        total: 4,
        supportedRate: 0.75,
        hallucinationRate: 0.25,
        stalenessRate: 0,
        unverifiedRate: 0,
      },
      {
        supported: 4,
        invented: 1,
        stale: 0,
        unverified: 0,
        total: 5,
        supportedRate: 0.8,
        hallucinationRate: 0.2,
        stalenessRate: 0,
        unverifiedRate: 0,
      },
      {
        supported: 3,
        invented: 1,
        stale: 0,
        unverified: 0,
        total: 4,
        supportedRate: 0.75,
        hallucinationRate: 0.25,
        stalenessRate: 0,
        unverifiedRate: 0,
      },
    ]);
    expect(
      result.checkpoints.every(
        (checkpoint) => checkpoint.evaluationCompleteness.rate === 1,
      ),
    ).toBe(true);
    expect(
      result.checkpoints.flatMap(
        (checkpoint) =>
          checkpoint.evaluations?.precisionEvaluations.filter(
            (evaluation) => evaluation.verdict === "invented",
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
    // The obsolete versions watched at T2 are `changed` and `removed` as they
    // stood at T1 (their signatures were unchanged from T0), both content-hashed
    // rather than checkpoint-tagged.
    const surfaceT1 = await extractSurface(repo.repoPath, repo.shas[1]);
    const obsoleteVersionId = (factId: string): string => {
      const item = surfaceT1.find((entry) => entry.factId === factId);
      if (item === undefined) {
        throw new Error(`missing surface item ${factId}`);
      }
      return item.factVersionId;
    };
    expect(result.checkpoints[2].evaluations?.forgettingEvaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          factVersionId: obsoleteVersionId("symbol:changed"),
          verdict: "forgotten",
        }),
        expect.objectContaining({
          factVersionId: obsoleteVersionId("symbol:removed"),
          verdict: "forgotten",
        }),
      ]),
    );
    // Each checkpoint runs extraction and grounding; forgetting runs only at T2,
    // where obsolete versions exist. The passes run concurrently within each
    // checkpoint, so assert per-pass counts rather than the exact sequence.
    const promptCount = (prompt: string): number =>
      modelControl.systemPrompts.filter((seen) => seen === prompt).length;
    expect(promptCount(FORGETTING_SYSTEM)).toBe(1);
    expect(promptCount(PRECISION_EXTRACTION_SYSTEM)).toBe(3);
    expect(promptCount(PRECISION_JUDGMENT_SYSTEM)).toBe(3);
    expect(promptCount(PRECISION_HISTORY_JUDGMENT_SYSTEM)).toBe(2);
    // Precision judgment always trails its own extraction, even when interleaved
    // with the other passes: at no prefix have more judgments run than extractions.
    let extractions = 0;
    let judgments = 0;
    for (const prompt of modelControl.systemPrompts) {
      if (prompt === PRECISION_EXTRACTION_SYSTEM) {
        extractions += 1;
      } else if (prompt === PRECISION_JUDGMENT_SYSTEM) {
        judgments += 1;
        expect(judgments).toBeLessThanOrEqual(extractions);
      }
    }
    // Forgetting and precision overlap rather than running strictly serially.
    expect(modelControl.maxActive).toBeGreaterThan(1);
    expect(modelControl.signals).toHaveLength(9);
    expect(workspaceRoots).toHaveLength(1);
    await expect(stat(workspaceRoots[0])).rejects.toMatchObject({
      code: "ENOENT",
    });

    const runDir = await writeRunResult(resultsDir, result);
    const persisted = JSON.parse(
      await readFile(path.join(runDir, "result.json"), "utf8"),
    ) as LedgerRunResult;
    expect(persisted.metadata).not.toHaveProperty("evaluatorPromptVersion");
    expect(persisted.checkpoints[0].evaluations?.precisionEvaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assertion: "Stable behavior is enabled.",
          adjudicatedBy: "source",
          verdict: "supported",
        }),
        expect.objectContaining({
          assertion: "Undocumented magic is available.",
          adjudicatedBy: "source",
          verdict: "invented",
        }),
      ]),
    );
    expect(formatReport(result)).toContain("Invented current claims (1)");
  });

  test("times out a hanging pass, degrades it fail-soft, and still completes and cleans up", async () => {
    modelControl.hangingSystemPrompt = FORGETTING_SYSTEM;
    const backend = new ModelEvaluationBackend({
      provider: "anthropic",
      modelId: "scripted-model",
      timeoutMs: 10,
    });

    // A persistently hanging forgetting pass no longer aborts the run: it times
    // out, exhausts isolated repair, and degrades each forgetting verdict to
    // indeterminate, so the benchmark resolves rather than rejecting.
    const result = await runBenchmark({
      benchmark: benchmark(repo),
      system: new EvolvingDocumentationSystem(),
      evaluationBackend: backend,
      config: config(resultsDir),
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    const forgettingVerdicts = result.checkpoints.flatMap(
      (checkpoint) => checkpoint.evaluations?.forgettingEvaluations ?? [],
    );
    expect(forgettingVerdicts.length).toBeGreaterThan(0);
    expect(
      forgettingVerdicts.every(
        (verdict) => verdict.verdict === "indeterminate",
      ),
    ).toBe(true);
    expect(
      forgettingVerdicts.every((verdict) =>
        /pass "forgetting" failed after 2 attempts/u.test(verdict.rationale),
      ),
    ).toBe(true);

    // The timed-out forgetting invocations were aborted; the concurrent precision
    // and forgetting invocations completed normally and were not.
    expect(modelControl.signals.some((signal) => signal.aborted)).toBe(true);

    // Replay resources are cleaned up despite the timeouts.
    expect(workspaceRoots).toHaveLength(1);
    await expect(stat(workspaceRoots[0])).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
