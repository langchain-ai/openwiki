import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type {
  EvidenceCorpus,
  LedgerRunResult,
  KnowledgeArtifact,
} from "../core/types.js";
import {
  prepareRunDirectory,
  writeArtifactSnapshot,
  writeEvidenceCorpus,
  writeRunResult,
} from "./persistence.js";
import {
  loadSavedArtifact,
  loadSavedEvidence,
  loadSavedRunResult,
} from "./saved-run.js";

/**
 * Build the minimum complete result needed by saved-run loading tests.
 *
 * @param startedAt - Timestamp that determines the persisted run directory.
 *
 * @returns A serializable empty LEDGER result.
 */
function result(startedAt: string): LedgerRunResult {
  return {
    metadata: {
      benchmarkName: "saved",
      startedAt,
      system: { provider: "fake", modelId: "system" },
    },
    checkpoints: [],
    score: {
      traceCoverage: 0,
      tracePrecision: 0,
      traceHallucinationRate: 0,
      traceStalenessRate: 0,
      traceUnverifiedRate: 0,
      evaluationCompleteness: 1,
      quality: 0,
      maintenanceRates: {},
      ledgerScore: 0,
    },
    diagnostics: {
      recovery: { recovered: 0, eligible: 0 },
      staleKnowledge: { records: [], unresolvedCount: 0 },
    },
  };
}

describe("saved run inputs", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test("round-trips immutable artifacts, evidence, and run metadata", async () => {
    const resultsDir = await mkdtemp(path.join(os.tmpdir(), "ledger-saved-"));
    temporaryDirectories.push(resultsDir);
    const startedAt = "2026-01-01T00:00:00.000Z";
    const runDir = await prepareRunDirectory(resultsDir, "saved", startedAt);
    const artifact: KnowledgeArtifact = {
      checkpointId: "T0",
      snapshotDir: "/unused",
      fingerprint: "abc123",
      documents: [
        { relativePath: "guide/intro.md", content: "# Introduction\n" },
      ],
    };
    const evidence: EvidenceCorpus = {
      checkpointId: "T0",
      records: [
        {
          evidenceId: "source::0000",
          sourceRef: "src/code.ts",
          observedAtCheckpoint: "T0",
          current: true,
          content: "export const value = 1;",
        },
      ],
    };

    await writeArtifactSnapshot(runDir, artifact);
    await writeEvidenceCorpus(runDir, evidence);
    await writeRunResult(resultsDir, result(startedAt));

    await expect(loadSavedArtifact(runDir, "T0")).resolves.toMatchObject({
      checkpointId: "T0",
      fingerprint: "abc123",
      documents: artifact.documents,
    });
    await expect(loadSavedEvidence(runDir, "T0")).resolves.toEqual(evidence);
    await expect(loadSavedRunResult(runDir)).resolves.toEqual(
      result(startedAt),
    );
  });

  test("rejects a document path that escapes its saved snapshot", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "ledger-saved-"));
    temporaryDirectories.push(runDir);
    const artifactsDir = path.join(runDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      path.join(artifactsDir, "T0.json"),
      JSON.stringify({
        checkpointId: "T0",
        fingerprint: "abc123",
        documents: ["../outside.md"],
      }),
      "utf8",
    );

    await expect(loadSavedArtifact(runDir, "T0")).rejects.toThrow(
      /Refusing to read saved artifact outside/u,
    );
  });
});
