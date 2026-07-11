import { execFile } from "node:child_process";
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
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";

const execFileAsync = promisify(execFile);

type GitRepoConfig = {
  repos: {
    id: string;
    path: string;
  }[];
};

type GitRepoManifest = {
  branch: string;
  changedFiles: string[];
  head: string;
  id: string;
  path: string;
  previousHead?: string;
  recentCommits: string[];
  status: string;
};

const definition: ConnectorDefinition = {
  backend: "local-git",
  description:
    "Reads local cloned Git repositories and writes compact manifests for the update agent.",
  displayName: "Local Git repositories",
  id: "git-repo",
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
      message:
        "No local repositories configured. Add repos to ~/.openwiki/connectors/git-repo/config.json.",
      rawFiles,
      runId,
      statePath: "~/.openwiki/connectors/git-repo/state.json",
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
    try {
      const manifest = await createRepoManifest(repo.id, repoPath);
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
    statePath: "~/.openwiki/connectors/git-repo/state.json",
    status: manifests.length > 0 ? "success" : "skipped",
    warnings,
  };
}

async function createRepoManifest(
  id: string,
  repoPath: string,
): Promise<GitRepoManifest> {
  const branch = await runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = await runGit(repoPath, ["rev-parse", "HEAD"]);
  const recentCommits = (
    await runGit(repoPath, [
      "log",
      "--max-count=20",
      "--name-status",
      "--oneline",
    ])
  )
    .split(/\r?\n/u)
    .filter(Boolean);
  const status = await runGit(repoPath, ["status", "--short"]);
  const changedFiles = (
    await runGit(repoPath, ["diff", "--name-status", "HEAD"])
  )
    .split(/\r?\n/u)
    .filter(Boolean);

  return {
    branch,
    changedFiles,
    head,
    id,
    path: repoPath,
    recentCommits,
    status,
  };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 1024 * 1024,
  });

  return stdout.trim();
}

function isSafeRepoId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
