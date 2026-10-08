/**
 * Spawns one isolated wiki-update agent call (scripts/run-source-update-batch.ts)
 * as a fresh subprocess, for the same reason as run-mesh-maintenance-process.ts:
 * chaining agent calls in-process risks a "terminated" failure. Used by
 * src/wiki/pipeline.ts for enrichment, split, and merge operations.
 *
 * Uses `spawn(..., { detached: true })` and kills the whole process group on
 * timeout, since `pnpm exec tsx` spawns a descendant tree (pnpm -> node ->
 * tsx) and a plain kill of the direct child would leave it running.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS =
  Number(process.env.OPENWIKI_SOURCE_UPDATE_TIMEOUT_MS) || 20 * 60 * 1000;

export class SourceUpdateProcessError extends Error {}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already exited, or never got its own group — nothing left to kill.
  }
}

/**
 * Runs one batch of a per-source wiki update in a fresh subprocess. Throws
 * `SourceUpdateProcessError` on a non-zero exit, a timeout, or a failure to
 * start — callers should treat this as one failed batch; earlier batches'
 * writes are already durable on disk and are not discarded.
 */
export async function runSourceUpdateProcess(
  userMessage: string,
  cwd: string,
  repoRoot: string,
  { modelId, timeoutMs = DEFAULT_TIMEOUT_MS }: { modelId?: string | null; timeoutMs?: number } = {},
): Promise<void> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-source-update-"));
  const inputPath = path.join(tmpDir, "input.json");
  await writeFile(inputPath, JSON.stringify({ cwd, modelId, userMessage }), "utf8");

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "pnpm",
        ["exec", "tsx", "scripts/run-source-update-batch.ts", inputPath],
        { cwd: repoRoot, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

      const timer = setTimeout(() => {
        if (child.pid) killProcessGroup(child.pid);
        reject(
          new SourceUpdateProcessError(`Source update batch timed out after ${timeoutMs}ms.`),
        );
      }, timeoutMs);

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new SourceUpdateProcessError(`Failed to start source update batch: ${error.message}`));
      });

      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new SourceUpdateProcessError(
              `Source update batch exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
            ),
          );
          return;
        }
        resolve();
      });
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
