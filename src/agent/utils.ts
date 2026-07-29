import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { OPEN_WIKI_DIR, UPDATE_METADATA_PATH } from "../constants.js";
import {
  isExpectedSnapshotRaceError,
  isFileNotFoundError,
} from "../fs-errors.js";
import { resolveLanguage } from "../language.js";
import {
  readOpenWikiOnboardingConfig,
  readRepositoryWikiInstructions,
} from "../onboarding.js";
import { OpenWikiIgnoreRules } from "./openwiki-ignore.js";
import type {
  OpenWikiCommand,
  OpenWikiOutputMode,
  OpenWikiRunOptions,
  RunContext,
  UpdateMetadata,
  UpdateRunStatus,
} from "./types.js";
import type { Dirent } from "node:fs";

const execFileAsync = promisify(execFile);
const LOCAL_WIKI_METADATA_PATH = ".last-update.json";
const TEMPORARY_PLAN_FILE = "_plan.md";

export type OpenWikiContentSnapshot = string;

export type UpdateNoopStatus =
  | {
      shouldSkip: true;
      gitHead: string;
      model: string;
    }
  | {
      shouldSkip: false;
      reason: string;
    };

/**
 * Builds the per-run context the prompt uses to reason about prior docs and git changes.
 *
 * Paths excluded by `ignoreRules` are stripped from the git evidence so the
 * agent never sees changes under an ignored path.
 */
export async function createRunContext(
  command: OpenWikiCommand,
  cwd: string,
  outputMode: OpenWikiOutputMode = "repository",
  language?: string | null,
  ignoreRules = new OpenWikiIgnoreRules([]),
): Promise<RunContext> {
  const lastUpdate = await readLastUpdate(cwd, outputMode);
  // A validated flag wins; otherwise inherit the wiki's persisted language so an
  // update without --language keeps the existing wiki consistent instead of
  // producing a mix of the old and new language.
  const requestedLanguage = resolveLanguage(language).language;
  // English is materialized as "en" rather than encoded by an absent key, so the
  // wiki's language is always explicit in metadata and every run inherits a
  // concrete value.
  const effectiveLanguage = requestedLanguage ?? lastUpdate?.language ?? "en";
  const languageContext = { language: effectiveLanguage };
  const wikiGoal = await readRunWikiGoal(cwd, outputMode);

  if (command === "chat") {
    return {
      lastUpdate,
      gitSummary: "Not applicable for chat.",
      ...languageContext,
      wikiGoal,
    };
  }

  if (outputMode === "local-wiki") {
    return {
      lastUpdate,
      gitSummary:
        "Local wiki mode: connector source evidence is provided through raw data paths and OpenWiki connector tools. Git repository diff context is not used for this run.",
      ...languageContext,
      wikiGoal,
    };
  }

  return {
    lastUpdate,
    gitSummary: await createGitSummary(command, cwd, lastUpdate, ignoreRules),
    ...languageContext,
    wikiGoal,
  };
}

async function readRunWikiGoal(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): Promise<string | undefined> {
  if (outputMode === "repository") {
    return readRepositoryWikiInstructions(cwd);
  }

  return (await readOpenWikiOnboardingConfig()).wikiGoal;
}

/**
 * Decides whether an `update` run can be skipped because nothing meaningful changed.
 *
 * Working-tree and committed changes that only touch `openwiki/` or paths
 * excluded by `ignoreRules` do not count as meaningful, so an ignored path
 * changing on its own never forces a rebuild.
 */
export async function getUpdateNoopStatus(
  cwd: string,
  ignoreRules = new OpenWikiIgnoreRules([]),
): Promise<UpdateNoopStatus> {
  const lastUpdate = await readLastUpdate(cwd, "repository");

  if (!lastUpdate?.gitHead) {
    return { shouldSkip: false, reason: "missing previous update git head" };
  }

  if (lastUpdate.status === "interrupted") {
    return { shouldSkip: false, reason: "previous update was interrupted" };
  }

  const head = await getGitHead(cwd);

  if (!head) {
    return { shouldSkip: false, reason: "missing current git head" };
  }

  const status = await runGit(cwd, [
    "status",
    "--short",
    "--untracked-files=all",
  ]);
  const meaningfulStatus = status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !isUpdateMetadataStatusLine(line))
    .filter((line) => !lineReferencesIgnoredPath(line, ignoreRules));

  if (meaningfulStatus.length > 0) {
    return { shouldSkip: false, reason: "worktree has changes" };
  }

  if (head !== lastUpdate.gitHead) {
    const committedPaths = await getChangedPathsSinceLastUpdate(
      cwd,
      lastUpdate.gitHead,
    );

    if (
      committedPaths.length === 0 ||
      committedPaths.some(
        (changedPath) =>
          !isOpenWikiPath(changedPath) && !ignoreRules.ignores(changedPath),
      )
    ) {
      return { shouldSkip: false, reason: "git head changed" };
    }
  }

  return {
    shouldSkip: true,
    gitHead: head,
    model: lastUpdate.model,
  };
}

export function shouldCheckUpdateNoop(options: OpenWikiRunOptions): boolean {
  return !options.userMessage?.trim();
}

/**
 * Records an init/update run so future updates can diff from this git head.
 * Interrupted runs are recorded with status "interrupted" so the update
 * no-op check knows the wiki may be partial and does not skip the retry.
 */
export async function writeLastUpdateMetadata(
  command: OpenWikiCommand,
  cwd: string,
  modelId: string,
  outputMode: OpenWikiOutputMode = "repository",
  status: UpdateRunStatus = "complete",
  language?: string,
): Promise<void> {
  const metadataFile = getMetadataFilePath(cwd, outputMode);
  const metadata: UpdateMetadata = {
    updatedAt: new Date().toISOString(),
    command,
    gitHead: outputMode === "repository" ? await getGitHead(cwd) : undefined,
    model: modelId,
    status,
    ...(language ? { language } : {}),
  };

  await mkdir(path.dirname(metadataFile), { recursive: true });
  await writeFile(
    metadataFile,
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Persists run metadata when OpenWiki content changed since the given snapshot.
 * Returns whether metadata was written. Used after both successful and failed
 * runs so already-generated content stays diffable by future updates.
 */
export async function persistRunMetadataIfChanged(
  command: OpenWikiCommand,
  cwd: string,
  modelId: string,
  outputMode: OpenWikiOutputMode,
  snapshotBefore: OpenWikiContentSnapshot | null,
  status: UpdateRunStatus = "complete",
  language?: string,
): Promise<boolean> {
  if (command === "chat" || snapshotBefore === null) {
    return false;
  }

  if (
    snapshotBefore === (await createOpenWikiContentSnapshot(cwd, outputMode))
  ) {
    // A completed run clears a previous interrupted status even when the
    // content did not change, so the update no-op check can skip again.
    const lastUpdate = await readLastUpdate(cwd, outputMode);
    if (status !== "complete" || lastUpdate?.status !== "interrupted") {
      return false;
    }
  }

  await writeLastUpdateMetadata(
    command,
    cwd,
    modelId,
    outputMode,
    status,
    language,
  );

  return true;
}

/**
 * Removes the temporary planning file the agent creates during init/update runs.
 */
export async function removeTemporaryPlanFile(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): Promise<boolean> {
  const planFile = getTemporaryPlanFilePath(cwd, outputMode);

  try {
    await rm(planFile);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

/**
 * Hashes OpenWiki content, excluding run metadata, to detect real documentation changes.
 */
export async function createOpenWikiContentSnapshot(
  cwd: string,
  outputMode: OpenWikiOutputMode = "repository",
): Promise<OpenWikiContentSnapshot> {
  const openWikiDir = getWikiContentRoot(cwd, outputMode);
  const hash = createHash("sha256");

  await addDirectoryToSnapshot(hash, openWikiDir, "");

  return hash.digest("hex");
}

/**
 * Reads prior run metadata if it exists and is structurally valid.
 */
async function readLastUpdate(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): Promise<UpdateMetadata | null> {
  const metadataFile = getMetadataFilePath(cwd, outputMode);

  try {
    const rawMetadata = await readFile(metadataFile, "utf8");
    const parsedMetadata = JSON.parse(rawMetadata) as Partial<UpdateMetadata>;

    if (
      typeof parsedMetadata.updatedAt === "string" &&
      typeof parsedMetadata.command === "string" &&
      typeof parsedMetadata.model === "string"
    ) {
      return {
        updatedAt: parsedMetadata.updatedAt,
        command: parsedMetadata.command === "init" ? "init" : "update",
        gitHead:
          typeof parsedMetadata.gitHead === "string"
            ? parsedMetadata.gitHead
            : undefined,
        model: parsedMetadata.model,
        // Metadata written before the status field existed is treated as
        // complete so upgrades do not force a spurious re-run.
        status:
          parsedMetadata.status === "interrupted" ? "interrupted" : "complete",
        language:
          typeof parsedMetadata.language === "string"
            ? parsedMetadata.language
            : undefined,
      };
    }

    return null;
  } catch (error) {
    if (isFileNotFoundError(error) || error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

/**
 * Recursively adds stable file paths and bytes to the OpenWiki content snapshot.
 */
async function addDirectoryToSnapshot(
  hash: ReturnType<typeof createHash>,
  directory: string,
  relativeDirectory: string,
): Promise<void> {
  let entries: Dirent[];

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isExpectedSnapshotRaceError(error)) {
      hash.update("missing");
      return;
    }

    throw error;
  }

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = path.join(directory, entry.name);
    const relativePath = path.join(relativeDirectory, entry.name);

    if (isIgnoredSnapshotPath(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      hash.update(`dir:${relativePath}\0`);
      await addDirectoryToSnapshot(hash, entryPath, relativePath);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const fileContent = await readSnapshotFile(entryPath);

    if (fileContent === null) {
      continue;
    }

    hash.update(`file:${relativePath}\0`);
    hash.update(fileContent);
    hash.update("\0");
  }
}

function getWikiContentRoot(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): string {
  return outputMode === "local-wiki" ? cwd : path.join(cwd, OPEN_WIKI_DIR);
}

function getTemporaryPlanFilePath(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): string {
  return path.join(getWikiContentRoot(cwd, outputMode), TEMPORARY_PLAN_FILE);
}

function getMetadataFilePath(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): string {
  return outputMode === "local-wiki"
    ? path.join(cwd, LOCAL_WIKI_METADATA_PATH)
    : path.join(cwd, UPDATE_METADATA_PATH);
}

function isIgnoredSnapshotPath(relativePath: string): boolean {
  return (
    relativePath === path.basename(UPDATE_METADATA_PATH) ||
    relativePath === LOCAL_WIKI_METADATA_PATH ||
    relativePath === TEMPORARY_PLAN_FILE
  );
}

/**
 * Reads snapshot bytes while tolerating files that move mid-scan.
 */
async function readSnapshotFile(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isExpectedSnapshotRaceError(error)) {
      return null;
    }

    throw error;
  }
}

/**
 * Produces the git evidence block passed to init/update prompts.
 *
 * Lines that reference a path excluded by `ignoreRules` are filtered out of
 * every git section (status, log, diff) before the block is assembled.
 */
async function createGitSummary(
  command: OpenWikiCommand,
  cwd: string,
  lastUpdate: UpdateMetadata | null,
  ignoreRules: OpenWikiIgnoreRules,
): Promise<string> {
  const sections: string[] = [];
  const status = filterGitOutputForIgnore(
    await runGit(cwd, ["status", "--short"]),
    ignoreRules,
  );
  const head = await getGitHead(cwd);

  sections.push(formatGitSection("git status --short", status));
  sections.push(formatGitSection("git rev-parse HEAD", head ?? "(unknown)"));

  if (command === "update" && lastUpdate?.gitHead) {
    const logSinceLastHead = filterGitOutputForIgnore(
      await runGit(cwd, [
        "log",
        `${lastUpdate.gitHead}..HEAD`,
        "--name-status",
        "--oneline",
      ]),
      ignoreRules,
    );

    sections.push(
      formatGitSection(
        `git log ${lastUpdate.gitHead}..HEAD --name-status --oneline`,
        logSinceLastHead,
      ),
    );
  } else if (command === "update" && lastUpdate?.updatedAt) {
    const logSinceLastUpdate = filterGitOutputForIgnore(
      await runGit(cwd, [
        "log",
        "--since",
        lastUpdate.updatedAt,
        "--name-status",
        "--oneline",
      ]),
      ignoreRules,
    );

    sections.push(
      formatGitSection(
        `git log --since ${lastUpdate.updatedAt} --name-status --oneline`,
        logSinceLastUpdate,
      ),
    );
  } else {
    const recentLog = filterGitOutputForIgnore(
      await runGit(cwd, [
        "log",
        "--max-count=20",
        "--name-status",
        "--oneline",
      ]),
      ignoreRules,
    );

    if (command === "update") {
      sections.push("No prior OpenWiki update timestamp was found.");
    }

    sections.push(
      formatGitSection(
        "git log --max-count=20 --name-status --oneline",
        recentLog,
      ),
    );
  }

  const diff = filterGitOutputForIgnore(
    await runGit(cwd, ["diff", "--name-status", "HEAD"]),
    ignoreRules,
  );
  sections.push(formatGitSection("git diff --name-status HEAD", diff));

  return sections.join("\n\n");
}

async function getGitHead(cwd: string): Promise<string | undefined> {
  const head = await runGit(cwd, ["rev-parse", "HEAD"]);

  return head.length > 0 ? head : undefined;
}

/**
 * Runs git commands without failing the whole run for normal git command errors.
 */
async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["--no-pager", ...args],
      {
        cwd,
        maxBuffer: 1024 * 1024,
      },
    );

    return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
  } catch (error) {
    if (isExecError(error)) {
      return [error.stdout?.trim(), error.stderr?.trim()]
        .filter(Boolean)
        .join("\n")
        .trim();
    }

    throw error;
  }
}

function formatGitSection(command: string, output: string): string {
  return [`$ ${command}`, output.length > 0 ? output : "(no output)"].join(
    "\n",
  );
}

/**
 * Matches the two-character status field `git status --short` puts in front of
 * each path. The field is only one character wide on the first line of a
 * trimmed run, because `runGit` strips the leading space of an unstaged-only
 * status such as " M openwiki/.last-update.json".
 */
const GIT_STATUS_LINE_PATTERN = /^[ !?ACDMRTU]{1,2} (.+)$/u;

function isUpdateMetadataStatusLine(line: string): boolean {
  const statusPath = (GIT_STATUS_LINE_PATTERN.exec(line)?.[1] ?? line).trim();
  const normalizedPath = statusPath.replace(/\\/gu, "/");

  return (
    normalizedPath === UPDATE_METADATA_PATH ||
    normalizedPath.endsWith(` -> ${UPDATE_METADATA_PATH}`)
  );
}

async function getChangedPathsSinceLastUpdate(
  cwd: string,
  gitHead: string,
): Promise<string[]> {
  const diff = await runGit(cwd, ["diff", "--name-only", `${gitHead}..HEAD`]);

  return diff
    .split("\n")
    .map((line) => normalizeGitPath(line))
    .filter(Boolean);
}

function isOpenWikiPath(changedPath: string): boolean {
  return (
    changedPath === OPEN_WIKI_DIR || changedPath.startsWith(`${OPEN_WIKI_DIR}/`)
  );
}

function normalizeGitPath(value: string): string {
  return value.trim().replace(/\\/gu, "/");
}

/**
 * Strips lines that reference an ignored path from a block of git output.
 *
 * Returns the input unchanged when no rules are active. When filtering removes
 * every line, returns a placeholder so the prompt records that matching paths
 * existed but were excluded, rather than showing a misleadingly empty section.
 */
function filterGitOutputForIgnore(
  output: string,
  ignoreRules: OpenWikiIgnoreRules,
): string {
  if (!ignoreRules.isActive || output.length === 0) {
    return output;
  }

  const filteredOutput = output
    .split("\n")
    .filter((line) => !lineReferencesIgnoredPath(line, ignoreRules))
    .join("\n")
    .trim();

  return filteredOutput.length > 0
    ? filteredOutput
    : "(all matching paths are excluded by .openwikiignore)";
}

/**
 * Whether a single line of git output names at least one ignored path.
 */
function lineReferencesIgnoredPath(
  line: string,
  ignoreRules: OpenWikiIgnoreRules,
): boolean {
  return extractGitPaths(line).some((changedPath) =>
    ignoreRules.ignores(changedPath),
  );
}

/**
 * Pulls the file path(s) out of one line of `git status --short` or
 * `--name-status` output.
 *
 * Handles both the two-column short-status format and the letter-prefixed
 * name-status format, and returns an empty array for lines that carry no path
 * (such as `--oneline` commit headers). Rename lines yield both the old and new
 * paths so that either side matching a rule excludes the line.
 */
function extractGitPaths(line: string): string[] {
  const shortStatusMatch = /^(?:[ MARCUD?!]{2})\s+(.+)$/u.exec(line);
  const nameStatusMatch = /^(?:[ACDMRTUXB]\d*)\s+(.+)$/u.exec(line.trim());
  const pathsText = shortStatusMatch?.[1] ?? nameStatusMatch?.[1];

  if (!pathsText) {
    return [];
  }

  return splitGitPaths(pathsText).map(normalizeGitPath).filter(Boolean);
}

/**
 * Splits the path portion of a git line into individual paths.
 *
 * `--name-status` separates a rename's source and target with a tab, while
 * `git status --short` uses ` -> `; a plain single path is returned as-is.
 */
function splitGitPaths(pathsText: string): string[] {
  if (pathsText.includes("\t")) {
    return pathsText.split("\t");
  }

  if (pathsText.includes(" -> ")) {
    return pathsText.split(" -> ");
  }

  return [pathsText];
}

function isExecError(
  error: unknown,
): error is Error & { stdout?: string; stderr?: string } {
  return error instanceof Error && ("stdout" in error || "stderr" in error);
}
