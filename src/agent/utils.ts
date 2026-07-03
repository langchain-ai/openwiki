import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  OPEN_WIKI_DIR,
  OPENWIKI_IGNORE_PATH,
  UPDATE_METADATA_PATH,
} from "../constants.js";
import type { OpenWikiCommand, RunContext, UpdateMetadata } from "./types.js";
import type { Dirent } from "node:fs";

const execFileAsync = promisify(execFile);

export type OpenWikiContentSnapshot = string;

/**
 * Builds the per-run context the prompt uses to reason about prior docs and git changes.
 */
export async function createRunContext(
  command: OpenWikiCommand,
  cwd: string,
): Promise<RunContext> {
  const lastUpdate = await readLastUpdate(cwd);
  const ignoredPaths = await readIgnoredPaths(cwd);

  if (command === "chat") {
    return {
      lastUpdate,
      gitSummary: "Not applicable for chat.",
      ignoredPaths,
    };
  }

  return {
    lastUpdate,
    gitSummary: await createGitSummary(command, cwd, lastUpdate),
    ignoredPaths,
  };
}

/**
 * Records a successful init/update run so future updates can diff from this git head.
 */
export async function writeLastUpdateMetadata(
  command: OpenWikiCommand,
  cwd: string,
  modelId: string,
): Promise<void> {
  const metadataFile = path.join(cwd, UPDATE_METADATA_PATH);
  const metadata: UpdateMetadata = {
    updatedAt: new Date().toISOString(),
    command,
    gitHead: await getGitHead(cwd),
    model: modelId,
  };

  await mkdir(path.dirname(metadataFile), { recursive: true });
  await writeFile(
    metadataFile,
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Hashes OpenWiki content, excluding run metadata, to detect real documentation changes.
 */
export async function createOpenWikiContentSnapshot(
  cwd: string,
): Promise<OpenWikiContentSnapshot> {
  const openWikiDir = path.join(cwd, OPEN_WIKI_DIR);
  const hash = createHash("sha256");

  await addDirectoryToSnapshot(hash, openWikiDir, "");

  return hash.digest("hex");
}

const MAX_IGNORED_PATHS = 200;
const MAX_IGNORED_PATH_LENGTH = 200;

/**
 * Reads user-defined documentation exclusions from .openwikiignore at the repo root.
 */
async function readIgnoredPaths(cwd: string): Promise<string[]> {
  const ignoreFile = path.join(cwd, OPENWIKI_IGNORE_PATH);
  let rawIgnoreContent: string;

  try {
    rawIgnoreContent = await readFile(ignoreFile, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }

    throw error;
  }

  const lines = rawIgnoreContent.split("\n").map((line) => line.trim());
  const patterns: string[] = [];

  for (const [lineIndex, line] of lines.entries()) {
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("!")) {
      throw new Error(
        `${OPENWIKI_IGNORE_PATH}:${lineIndex + 1}: negation patterns are not supported. Remove the leading "!" or delete the line.`,
      );
    }

    if (line.length > MAX_IGNORED_PATH_LENGTH) {
      throw new Error(
        `${OPENWIKI_IGNORE_PATH}:${lineIndex + 1}: pattern is longer than ${MAX_IGNORED_PATH_LENGTH} characters. Shorten or remove it.`,
      );
    }

    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(line)) {
      throw new Error(
        `${OPENWIKI_IGNORE_PATH}:${lineIndex + 1}: pattern contains control characters. Remove them.`,
      );
    }

    patterns.push(line);
  }

  const uniquePatterns = Array.from(new Set(patterns));

  if (uniquePatterns.length > MAX_IGNORED_PATHS) {
    throw new Error(
      `${OPENWIKI_IGNORE_PATH} lists ${uniquePatterns.length} patterns; the maximum is ${MAX_IGNORED_PATHS}. Consolidate entries with broader glob patterns.`,
    );
  }

  return uniquePatterns;
}

/**
 * Reads prior run metadata if it exists and is structurally valid.
 */
async function readLastUpdate(cwd: string): Promise<UpdateMetadata | null> {
  const metadataFile = path.join(cwd, UPDATE_METADATA_PATH);

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

    if (relativePath === path.basename(UPDATE_METADATA_PATH)) {
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
 */
async function createGitSummary(
  command: OpenWikiCommand,
  cwd: string,
  lastUpdate: UpdateMetadata | null,
): Promise<string> {
  const sections: string[] = [];
  const status = await runGit(cwd, ["status", "--short"]);
  const head = await getGitHead(cwd);

  sections.push(formatGitSection("git status --short", status));
  sections.push(formatGitSection("git rev-parse HEAD", head ?? "(unknown)"));

  if (command === "update" && lastUpdate?.gitHead) {
    const logSinceLastHead = await runGit(cwd, [
      "log",
      `${lastUpdate.gitHead}..HEAD`,
      "--name-status",
      "--oneline",
    ]);

    sections.push(
      formatGitSection(
        `git log ${lastUpdate.gitHead}..HEAD --name-status --oneline`,
        logSinceLastHead,
      ),
    );
  } else if (command === "update" && lastUpdate?.updatedAt) {
    const logSinceLastUpdate = await runGit(cwd, [
      "log",
      "--since",
      lastUpdate.updatedAt,
      "--name-status",
      "--oneline",
    ]);

    sections.push(
      formatGitSection(
        `git log --since ${lastUpdate.updatedAt} --name-status --oneline`,
        logSinceLastUpdate,
      ),
    );
  } else {
    const recentLog = await runGit(cwd, [
      "log",
      "--max-count=20",
      "--name-status",
      "--oneline",
    ]);

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

  const diff = await runGit(cwd, ["diff", "--name-status", "HEAD"]);
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

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isExpectedSnapshotRaceError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  return ["EISDIR", "ENOENT", "ENOTDIR"].includes(
    (error as NodeJS.ErrnoException).code ?? "",
  );
}

function isExecError(
  error: unknown,
): error is Error & { stdout?: string; stderr?: string } {
  return error instanceof Error && ("stdout" in error || "stderr" in error);
}
