import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../io.js";
import { openWikiConnectorsDisplayPath } from "../../config/openwiki-home.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * Most lines kept from each list-style git command (`status`, `log`, `diff`).
 * Anything beyond it is dropped and reported through a `*Truncated` flag, so a
 * huge range or working tree can neither fail the repo nor flood the planner.
 */
const GIT_REPO_MANIFEST_LINE_LIMIT = 1000;

/**
 * Most UTF-8 bytes kept from each list-style git command. It also bounds a
 * single unterminated line, so a few enormous commit subjects cannot blow up
 * the manifest even when the line count is small.
 */
const GIT_REPO_MANIFEST_BYTE_LIMIT = 256 * 1024;

const GIT_STDERR_LIMIT = 64 * 1024;

type GitRepoConfig = {
  repos: {
    id: string;
    path: string;
  }[];
};

type GitRepoManifest = {
  branch: string;
  changedFiles: string[];
  changedFilesTruncated?: true;
  head: string;
  id: string;
  path: string;
  previousHead?: string;
  recentCommits: string[];
  recentCommitsTruncated?: true;
  status: string;
  statusTruncated?: true;
};

const definition: ConnectorDefinition = {
  backend: "local-git",
  description:
    "Reads local cloned Git repositories and writes compact manifests for the update agent.",
  displayName: "Local Git repositories",
  id: "git-repo",
  mode: "personal",
  requiredEnv: [],
  supportsAgenticDiscovery: true,
};

export function createGitRepoConnector(): ConnectorRuntime {
  return {
    ...definition,
    ingest,
  };
}

async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = await readConnectorConfig<GitRepoConfig>("git-repo", {
    repos: [],
  });
  const state = await readConnectorState("git-repo");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (config.repos.length === 0) {
    return {
      connectorId: "git-repo",
      message: `No local repositories configured. Add repos to ${openWikiConnectorsDisplayPath}/git-repo/config.json.`,
      rawFiles,
      runId,
      statePath: `${openWikiConnectorsDisplayPath}/git-repo/state.json`,
      status: "skipped",
      warnings,
    };
  }

  const limit = options.limit ?? config.repos.length;
  const manifests: GitRepoManifest[] = [];

  for (const repo of config.repos.slice(0, limit)) {
    if (!isSafeRepoId(repo.id)) {
      warnings.push(`Skipped repo with unsafe id: ${repo.id}`);
      continue;
    }

    const repoPath = path.resolve(repo.path);
    const previousHead = state.latestIds?.[repo.id];
    try {
      const manifest = await createRepoManifest(
        repo.id,
        repoPath,
        previousHead,
      );
      manifests.push(manifest);
    } catch (error) {
      warnings.push(`${repo.id}: ${getErrorMessage(error)}`);
    }
  }

  const manifestPath = await writeRawJson("git-repo", runId, "manifest.json", {
    generatedAt: new Date().toISOString(),
    repos: manifests,
  });
  rawFiles.push(manifestPath);

  const nextState = updateStateWithRun(state, {
    at: new Date().toISOString(),
    rawFiles,
    runId,
    status: manifests.length > 0 ? "success" : "skipped",
    warnings,
  });
  nextState.latestIds = {
    ...(nextState.latestIds ?? {}),
    ...Object.fromEntries(
      manifests.map((manifest) => [manifest.id, manifest.head]),
    ),
  };
  await writeConnectorState("git-repo", nextState);

  return {
    connectorId: "git-repo",
    message: `Wrote ${manifests.length} local git repo manifest(s).`,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/git-repo/state.json`,
    status: manifests.length > 0 ? "success" : "skipped",
    warnings,
  };
}

async function createRepoManifest(
  id: string,
  repoPath: string,
  previousHead?: string,
): Promise<GitRepoManifest> {
  const branch = await runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = await runGit(repoPath, ["rev-parse", "HEAD"]);
  const statusOutput = await runGitCapped(repoPath, ["status", "--short"]);

  // On repeat runs, describe what landed since the last ingestion by diffing
  // against the recorded head. `previousHead` is unusable on the first run
  // (undefined), when it matches the current head (nothing new committed), or
  // when the recorded commit is no longer reachable (history rewritten or a
  // force-push). In every unusable case we fall back to the working-tree diff
  // so the manifest still reflects local, uncommitted work.
  const usablePreviousHead =
    previousHead && previousHead !== head
      ? await resolveReachableHead(repoPath, previousHead)
      : undefined;

  const recentCommitsOutput = usablePreviousHead
    ? await runGitCapped(repoPath, [
        "log",
        "--name-status",
        "--oneline",
        `${usablePreviousHead}..HEAD`,
      ])
    : await runGitCapped(repoPath, [
        "log",
        "--max-count=20",
        "--name-status",
        "--oneline",
      ]);

  const changedFilesOutput = usablePreviousHead
    ? await runGitCapped(repoPath, [
        "diff",
        "--name-status",
        usablePreviousHead,
        "HEAD",
      ])
    : await runGitCapped(repoPath, ["diff", "--name-status", "HEAD"]);

  return {
    branch,
    changedFiles: changedFilesOutput.lines,
    ...(changedFilesOutput.truncated ? { changedFilesTruncated: true } : {}),
    head,
    id,
    path: repoPath,
    ...(usablePreviousHead ? { previousHead: usablePreviousHead } : {}),
    recentCommits: recentCommitsOutput.lines,
    ...(recentCommitsOutput.truncated ? { recentCommitsTruncated: true } : {}),
    status: statusOutput.lines.join("\n").trim(),
    ...(statusOutput.truncated ? { statusTruncated: true } : {}),
  };
}

/**
 * Returns the recorded head if it still points at a commit in this repository,
 * otherwise `undefined` (history was rewritten or the commit was garbage
 * collected, so a diff against it would fail).
 */
async function resolveReachableHead(
  repoPath: string,
  candidate: string,
): Promise<string | undefined> {
  try {
    await runGit(repoPath, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${candidate}^{commit}`,
    ]);
    return candidate;
  } catch {
    return undefined;
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 1024 * 1024,
  });

  return stdout.trim();
}

/**
 * Runs git and keeps at most `GIT_REPO_MANIFEST_LINE_LIMIT` non-empty lines
 * and `GIT_REPO_MANIFEST_BYTE_LIMIT` bytes. Output is streamed, so a range that prints far more than a buffer can hold
 * does not fail the command: once the limit is passed git is stopped and the
 * result is marked truncated.
 */
async function runGitCapped(
  cwd: string,
  args: string[],
): Promise<{ lines: string[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let pending = "";
    let stderr = "";
    let keptBytes = 0;
    let truncated = false;

    const truncate = (): void => {
      truncated = true;
      pending = "";
      child.kill();
    };

    const pushLine = (raw: string): void => {
      const line = raw.replace(/\r$/u, "");
      if (line.length === 0 || truncated) {
        return;
      }
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      if (
        lines.length >= GIT_REPO_MANIFEST_LINE_LIMIT ||
        keptBytes + lineBytes > GIT_REPO_MANIFEST_BYTE_LIMIT
      ) {
        truncate();
        return;
      }
      keptBytes += lineBytes;
      lines.push(line);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (truncated) {
        return;
      }
      pending += chunk;
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const part of parts) {
        pushLine(part);
      }
      if (!truncated && pending.length > GIT_REPO_MANIFEST_BYTE_LIMIT) {
        truncate();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < GIT_STDERR_LIMIT) {
        stderr += chunk;
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (truncated) {
        resolve({ lines, truncated });
        return;
      }
      pushLine(pending);
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() || `git ${args[0] ?? ""} exited with code ${code}`,
          ),
        );
        return;
      }
      resolve({ lines, truncated });
    });
  });
}

function isSafeRepoId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
