/**
 * Spawns the mesh-maintenance pipeline (src/wiki/pipeline.ts) as a fresh,
 * isolated subprocess rather than calling it in-process — chaining multiple
 * real agent runs back-to-back in one long-lived process is less reliable
 * than giving each its own process boundary, spawning
 * `scripts/run-mesh-maintenance.ts` the same way `pnpm exec tsx` already
 * spawns other standalone scripts in this repo.
 *
 * `spawn(..., { detached: true })` + killing the whole process group on
 * timeout is required because `pnpm exec tsx` spawns a descendant tree
 * (pnpm -> node -> tsx); a plain kill of the direct child would leave real
 * work orphaned and still running.
 */

import { spawn } from "node:child_process";

import type { MeshMaintenanceReport } from "./pipeline.js";

// A full pass chains one real LLM agent call per graduation, split, and
// merge candidate, so a large backlog can take a while; 60 minutes leaves
// headroom above typical worst-case runs and is overridable per-run via env
// for anyone hitting a larger backlog, same pattern as
// OPENWIKI_INGESTION_WINDOW_HOURS in ingestion.ts.
const DEFAULT_TIMEOUT_MS =
  Number(process.env.OPENWIKI_MESH_MAINTENANCE_TIMEOUT_MS) || 60 * 60 * 1000;

export class MeshMaintenanceProcessError extends Error {}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already exited, or never got its own group — nothing left to kill.
  }
}

/**
 * Runs mesh maintenance for one connector in a fresh subprocess and returns
 * its parsed report. Throws `MeshMaintenanceProcessError` on a non-zero
 * exit, a timeout, or unparseable output — callers should catch this and
 * degrade gracefully (a maintenance failure should never take down an
 * otherwise-successful ingestion run), the same way ingestion.ts already
 * does for a connector's own deterministic-pull failure.
 */
export async function runMeshMaintenanceProcess(
  connectorId: string,
  repoRoot: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<MeshMaintenanceReport> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "tsx", "scripts/run-mesh-maintenance.ts", connectorId],
      { cwd: repoRoot, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    const timer = setTimeout(() => {
      if (child.pid) killProcessGroup(child.pid);
      reject(
        new MeshMaintenanceProcessError(
          `Mesh maintenance for "${connectorId}" timed out after ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new MeshMaintenanceProcessError(`Failed to start mesh maintenance: ${error.message}`));
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new MeshMaintenanceProcessError(
            `Mesh maintenance for "${connectorId}" exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      const lastLine = stdout.trim().split("\n").at(-1) ?? "";
      try {
        resolve(JSON.parse(lastLine) as MeshMaintenanceReport);
      } catch {
        reject(
          new MeshMaintenanceProcessError(
            `Mesh maintenance for "${connectorId}" produced unparseable output: ${stdout.slice(0, 500)}`,
          ),
        );
      }
    });
  });
}
