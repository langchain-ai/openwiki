import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  OPEN_WIKI_DIR,
  PAGE_MANIFEST_PATH,
  UPDATE_METADATA_PATH,
} from "../config/constants.js";
import {
  isExpectedSnapshotRaceError,
  isFileNotFoundError,
} from "../platform/fs-errors.js";
import {
  getPrimaryLanguageSubtag,
  resolveLanguage,
} from "../platform/language.js";
import {
  readOpenWikiOnboardingConfig,
  readRepositoryWikiInstructions,
} from "../setup/onboarding.js";
import { OPENWIKI_IGNORE_FILE, OpenWikiIgnore } from "./openwiki-ignore.js";
import type {
  OpenWikiCommand,
  OpenWikiOutputMode,
  OpenWikiRunOptions,
  RunContext,
  UpdateMetadata,
  UpdateRunStatus,
} from "./types.js";
const execFileAsync = promisify(execFile);
const LOCAL_WIKI_METADATA_PATH = ".last-update.json";
const REPOSITORY_RUN_STATE_BASENAME = ".run.json";
// Recursive-monorepo generator state persisted at openwiki/.workspaces-state.json.
// It is OpenWiki bookkeeping, not wiki content, so it must be excluded from the
// content snapshot or a recursive update's per-subproject state write would read
// as a spurious wiki change and defeat the no-op check.
const WORKSPACES_STATE_BASENAME = ".workspaces-state.json";

/**
 * Restricts the git evidence / no-op commands to a subtree of the repository.
 *
 * `git status`/`git diff`/`git ls-files` are REPO-WIDE regardless of the process
 * cwd, so rooting a run at a subproject directory does NOT scope its git
 * evidence — only a pathspec does. Recursive monorepo runs need that scoping so a
 * subproject's no-op check and planner context see only its own subtree.
 *
 * - `subproject`: cwd is the subproject directory; commands add a `-- .` pathspec
 *   (plus `--relative` on diff) so output paths are subproject-relative
 *   (`openwiki/x.md`, `src/code.ts`) and sibling/parent changes are invisible.
 * - `root-excluding-nested`: cwd is the repository root; commands keep the root
 *   `openwiki/` but exclude nested `**` + `/openwiki/` subtrees so freshly
 *   generated sub-wikis are not presented to the root planner as source churn.
 *
 * When `scope` is undefined the git commands are byte-identical to the
 * non-recursive behavior (no pathspec, no `--relative`).
 */
export type GitScope =
  | { mode: "subproject" }
  | { mode: "root-excluding-nested" };

/**
 * Builds the `--relative` flag and trailing pathspec args for a scoped git
 * command. `useRelative` is only honored for the subproject scope (status stays
 * cwd-relative and does not take `--relative`).
 */
function gitScopeArgs(
  scope: GitScope | undefined,
  useRelative: boolean,
): { relative: string[]; pathspec: string[] } {
  if (!scope) {
    return { relative: [], pathspec: [] };
  }

  if (scope.mode === "subproject") {
    return {
      relative: useRelative ? ["--relative"] : [],
      pathspec: ["--", "."],
    };
  }

  // Root scope: keep the root wiki but drop any nested openwiki subtrees.
  return { relative: [], pathspec: ["--", ".", ":(exclude)**/openwiki/**"] };
}

export type OpenWikiContentSnapshot = string;

export type UpdateNoopStatus =
  | {
      shouldSkip: true;
      gitHead: string;
      model: string;

      /**
       * The wiki's persisted language, carried through so a no-op metadata
       * refresh re-writes `.last-update.json` without dropping it.
       *
       * @default undefined - the previous run recorded no language (a wiki
       * created before language tracking); the refresh omits the field too.
       */
      language?: string;
    }
  | {
      shouldSkip: false;
      reason: string;
    };

/**
 * Builds the persisted per-run context used by the prompt.
 */
export async function createRunContext(
  cwd: string,
  outputMode: OpenWikiOutputMode = "repository",
  language?: string | null,
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

  return {
    lastUpdate,
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
 * Decides whether an update can skip its model invocation.
 *
 * An explicit request whose primary language differs from the persisted wiki
 * language is meaningful even on a clean tree, because the translation pass
 * must run before the update agent.
 *
 * Working-tree and committed changes that only touch `openwiki/` or paths
 * excluded by `openWikiIgnore` do not count as meaningful, so an ignored path
 * changing on its own never forces a rebuild.
 *
 * @param cwd - Absolute repository root.
 * @param openWikiIgnore - Active repository read boundary.
 * @param requestedLanguage - Optional output language requested for this run.
 * @returns Skip decision and diagnostic reason.
 */
export async function getUpdateNoopStatus(
  cwd: string,
  openWikiIgnore = new OpenWikiIgnore([]),
  requestedLanguage?: string | null,
  scope?: GitScope,
): Promise<UpdateNoopStatus> {
  const lastUpdate = await readLastUpdate(cwd, "repository");

  if (!lastUpdate?.gitHead) {
    return { shouldSkip: false, reason: "missing previous update git head" };
  }

  if (lastUpdate.status === "interrupted") {
    return { shouldSkip: false, reason: "previous update was interrupted" };
  }

  const resolvedRequestedLanguage = resolveLanguage(requestedLanguage).language;
  if (
    resolvedRequestedLanguage !== undefined &&
    getPrimaryLanguageSubtag(resolvedRequestedLanguage) !==
      getPrimaryLanguageSubtag(lastUpdate.language)
  ) {
    return { shouldSkip: false, reason: "output language changed" };
  }

  const head = await getGitHead(cwd);

  if (!head) {
    return { shouldSkip: false, reason: "missing current git head" };
  }

  const { pathspec: statusPathspec } = gitScopeArgs(scope, false);
  const status = await runGit(cwd, [
    "status",
    "--short",
    "--untracked-files=all",
    ...statusPathspec,
  ]);
  const meaningfulStatus = status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !isUpdateMetadataStatusLine(line))
    .filter((line) => !lineReferencesIgnoredPath(line, openWikiIgnore));

  if (meaningfulStatus.length > 0) {
    return { shouldSkip: false, reason: "worktree has changes" };
  }

  if (head !== lastUpdate.gitHead) {
    const committedPaths = await getChangedPathsSinceLastUpdate(
      cwd,
      lastUpdate.gitHead,
      scope,
    );
    const hasMeaningfulCommit = committedPaths.some(
      (changedPath) =>
        !isOpenWikiPath(changedPath) && !openWikiIgnore.ignores(changedPath),
    );

    // An unscoped run conservatively regenerates when the head moved but no
    // changed paths resolved. A SUBPROJECT-scoped run with an empty in-subtree
    // diff is a legitimate skip — a sibling's commit moved the shared HEAD but
    // changed nothing under this subproject — so only a meaningful in-scope
    // change forces regeneration. This is what makes the per-subproject "no
    // dependency cascade" update model hold; git status/diff are repo-wide, so
    // without the scope every sibling commit would regenerate every subproject.
    if ((scope === undefined && committedPaths.length === 0) || hasMeaningfulCommit) {
      return { shouldSkip: false, reason: "git head changed" };
    }
  }

  return {
    shouldSkip: true,
    gitHead: head,
    model: lastUpdate.model,
    language: lastUpdate.language,
  };
}

export function shouldCheckUpdateNoop(options: OpenWikiRunOptions): boolean {
  return !options.userMessage?.trim();
}

/**
 * Records an init/update run so future updates can diff from this git head.
 * Interrupted runs are recorded with status "interrupted" so the update
 * no-op check knows the wiki may be partial and does not skip the retry.
 * A `null` override deliberately omits the checkpoint when no successful
 * repository baseline exists.
 */
export async function writeLastUpdateMetadata(
  command: OpenWikiCommand,
  cwd: string,
  modelId: string,
  outputMode: OpenWikiOutputMode = "repository",
  status: UpdateRunStatus = "complete",
  language?: string,
  gitHeadOverride?: string | null,
): Promise<void> {
  const metadataFile = getMetadataFilePath(cwd, outputMode);
  const gitHead =
    outputMode !== "repository"
      ? undefined
      : gitHeadOverride === null
        ? undefined
        : (gitHeadOverride ?? (await getGitHead(cwd)));
  const metadata: UpdateMetadata = {
    updatedAt: new Date().toISOString(),
    command,
    gitHead,
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
 * Persists run metadata after an update/init run. Always refreshes the
 * `.last-update.json` timestamp so freshness checks reflect the actual last
 * run, even when the wiki content is unchanged (a no-op update still means
 * OpenWiki ran). A completed run also clears any previous interrupted status
 * so the update no-op check can skip again. Returns whether metadata was
 * written (always true for non-chat runs).
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

const SOURCE_FINGERPRINT_VERSION = "openwiki-source-fingerprint-v1";
const SOURCE_FINGERPRINT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

interface SourceStatusEntry {
  /**
   * Two-column Git porcelain status code for the path.
   */
  code: string;

  /**
   * Repository-relative path decoded from NUL-delimited Git output.
   */
  path: string;
}

/**
 * Exact repository source identity captured for one semantic plan.
 */
export interface RepositorySourceSnapshot {
  /**
   * Versioned hash of every model-visible source input.
   */
  fingerprint: string;

  /**
   * Git commit observed by the fingerprint operation.
   *
   * @default undefined for an unborn branch.
   */
  gitHead?: string;
}

/**
 * Hashes model-visible source input and returns its observed Git commit.
 *
 * Generated OpenWiki state and ignored paths are excluded. Git, stat, symlink,
 * and file-read failures reject because the fingerprint is a correctness gate.
 *
 * When `scope` is `{ mode: "subproject" }` the fingerprint is confined to the
 * subtree at `cwd`: the dirty-status query gains a `-- .` pathspec (and its
 * repo-root-relative paths are re-based to the subtree so `openwiki/` and
 * ignore filters match), and the HEAD contribution becomes the subtree's
 * last-touching commit rather than the global HEAD. This is what keeps a
 * subproject's fingerprint stable across a sibling's commit or working-tree
 * change. When `scope` is undefined the output is byte-identical to the
 * non-recursive behavior (global HEAD, no pathspec, no path re-basing).
 *
 * @param cwd - Absolute Git repository root (the subtree root when scoped).
 * @param openWikiIgnore - Ignore rules loaded for this run.
 * @param scope - Optional recursive git scope. Only the subproject scope alters
 *   output; any other value is treated as unscoped for the fingerprint.
 * @returns Paired source fingerprint and Git HEAD.
 */
export async function createRepositorySourceSnapshot(
  cwd: string,
  openWikiIgnore: OpenWikiIgnore,
  scope?: GitScope,
): Promise<RepositorySourceSnapshot> {
  if (!path.isAbsolute(cwd)) {
    throw new Error("Repository source fingerprint requires an absolute root.");
  }

  // Only the subproject scope changes fingerprint semantics; the root scope
  // deliberately stays repo-wide here (root is the aggregator), so collapse
  // anything other than a subproject scope to the unscoped path.
  const subprojectScope =
    scope?.mode === "subproject" ? scope : undefined;
  const { pathspec: statusPathspec } = gitScopeArgs(subprojectScope, false);

  const [head, trackedOutput, untrackedOutput, statusOutput, statusPrefix] =
    await Promise.all([
      readFingerprintHead(cwd, subprojectScope),
      runFingerprintGit(cwd, ["ls-files", "--cached", "-z"]),
      runFingerprintGit(cwd, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]),
      runFingerprintGit(cwd, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--no-renames",
        "-z",
        ...statusPathspec,
      ]),
      // `git status` reports repo-root-relative paths even with a `-- .`
      // pathspec, so a subproject run must strip the subtree prefix before the
      // openwiki/ignore filters (which expect subtree-relative paths) see them.
      // At the repository root the prefix is empty, so stripping is inert.
      subprojectScope
        ? readFingerprintStatusPrefix(cwd)
        : Promise.resolve(""),
    ]);

  const trackedPaths = new Set(
    splitFingerprintNul(trackedOutput).map(assertFingerprintGitPath),
  );
  const candidatePaths = new Set([
    ...trackedPaths,
    ...splitFingerprintNul(untrackedOutput).map(assertFingerprintGitPath),
  ]);
  if (await fingerprintEntryExists(path.join(cwd, OPENWIKI_IGNORE_FILE))) {
    candidatePaths.add(OPENWIKI_IGNORE_FILE);
  }

  const visiblePaths = [...candidatePaths]
    .filter((candidate) => isFingerprintSourcePath(candidate, openWikiIgnore))
    .sort(compareFingerprintStrings);
  const statusEntries = parseFingerprintStatus(statusOutput, statusPrefix)
    .filter(({ path: candidate }) =>
      isFingerprintSourcePath(candidate, openWikiIgnore),
    )
    .sort((left, right) =>
      compareFingerprintStrings(
        `${left.code}\u0000${left.path}`,
        `${right.code}\u0000${right.path}`,
      ),
    );

  const hash = createHash("sha256");
  updateFingerprintField(hash, "format", SOURCE_FINGERPRINT_VERSION);
  updateFingerprintField(hash, "head", head);
  for (const entry of statusEntries) {
    updateFingerprintField(hash, "status-code", entry.code);
    updateFingerprintField(hash, "status-path", entry.path);
  }
  for (const sourcePath of visiblePaths) {
    await updateFingerprintSourceEntry(
      hash,
      cwd,
      sourcePath,
      trackedPaths.has(sourcePath),
    );
  }

  const fingerprint = `sha256:${hash.digest("hex")}`;
  return {
    fingerprint,
    ...(head.startsWith("unborn:") ? {} : { gitHead: head }),
  };
}

/**
 * Hashes every model-visible repository source input for one semantic plan.
 *
 * @param cwd - Absolute Git repository root.
 * @param openWikiIgnore - Ignore rules loaded for this run.
 * @param scope - Optional recursive git scope (see createRepositorySourceSnapshot).
 * @returns A versioned `sha256:` fingerprint.
 */
export async function createRepositorySourceFingerprint(
  cwd: string,
  openWikiIgnore: OpenWikiIgnore,
  scope?: GitScope,
): Promise<string> {
  return (await createRepositorySourceSnapshot(cwd, openWikiIgnore, scope))
    .fingerprint;
}

/**
 * Resolves the current commit identity, including a stable unborn-branch form.
 *
 * For a subproject scope the identity is the subtree's last-touching commit
 * (`git log -1 -- .`), not the global HEAD, so a sibling commit that advances
 * the shared HEAD leaves this value — and therefore the fingerprint — unchanged.
 * That commit is also a real, reachable ancestor, so it remains a valid
 * `git diff <base>..HEAD -- .` baseline when it flows into the page manifest as
 * `entry.gitHead`.
 */
async function readFingerprintHead(
  cwd: string,
  scope?: GitScope,
): Promise<string> {
  if (scope?.mode === "subproject") {
    return readSubtreeFingerprintHead(cwd);
  }
  try {
    const head = (
      await runFingerprintGit(cwd, ["rev-parse", "--verify", "HEAD"])
    ).trimEnd();
    if (!head) throw new Error("Git returned an empty HEAD.");
    return head;
  } catch (headError) {
    try {
      const symbolicHead = (
        await runFingerprintGit(cwd, ["symbolic-ref", "-q", "HEAD"])
      ).trimEnd();
      if (symbolicHead) return `unborn:${symbolicHead}`;
    } catch {
      // The original rev-parse failure is the actionable correctness error.
    }
    throw new Error("Unable to resolve repository HEAD for fingerprinting.", {
      cause: headError,
    });
  }
}

/**
 * Resolves the last commit that touched the subtree at `cwd`.
 *
 * Empty output (exit 0) means the branch is born but no commit has touched this
 * subtree yet (e.g. an untracked-only new subproject) → `unborn:subtree`. A
 * `git log` failure only legitimately means the branch itself is unborn; we
 * confirm that with `rev-parse --verify HEAD` (which resolves a ref to a SHA
 * without loading commit objects, unlike `git log`) before returning an
 * `unborn:<ref>` sentinel — otherwise a `git log` failure on a *born* branch
 * (e.g. a corrupt object DB with an intact HEAD symref) would be masked as
 * unborn instead of propagating as the correctness error it is. Both sentinels
 * make the caller omit `gitHead` exactly as it does for a whole-repo unborn
 * branch, while still contributing a stable value to the hash.
 */
async function readSubtreeFingerprintHead(cwd: string): Promise<string> {
  try {
    const head = (
      await runFingerprintGit(cwd, ["log", "-1", "--format=%H", "--", "."])
    ).trimEnd();
    if (head) return head;
    return "unborn:subtree";
  } catch (headError) {
    // Only a HEAD that does not resolve to a commit is genuinely unborn; on a
    // born branch a git-log failure is real and must propagate.
    let headResolves = false;
    try {
      headResolves =
        (
          await runFingerprintGit(cwd, ["rev-parse", "--verify", "HEAD"])
        ).trimEnd().length > 0;
    } catch {
      // HEAD does not resolve — the branch is genuinely unborn.
    }
    if (!headResolves) {
      try {
        const symbolicHead = (
          await runFingerprintGit(cwd, ["symbolic-ref", "-q", "HEAD"])
        ).trimEnd();
        if (symbolicHead) return `unborn:${symbolicHead}`;
      } catch {
        // Fall through to the generic correctness error below.
      }
    }
    throw new Error("Unable to resolve repository HEAD for fingerprinting.", {
      cause: headError,
    });
  }
}

/**
 * Resolves the subtree prefix (`pkg/`) reported by `git rev-parse
 * --show-prefix`, used to re-base repo-root-relative status paths onto the
 * subtree. The prefix is empty at the repository root.
 */
async function readFingerprintStatusPrefix(cwd: string): Promise<string> {
  return (
    await runFingerprintGit(cwd, ["rev-parse", "--show-prefix"])
  ).trimEnd();
}

/**
 * Runs one bounded Git query required by source fingerprint construction.
 */
async function runFingerprintGit(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["--no-pager", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: SOURCE_FINGERPRINT_MAX_BUFFER_BYTES,
    });
    return stdout;
  } catch (error) {
    throw new Error(
      `Git failed while creating the repository source fingerprint: git ${args.join(" ")}`,
      { cause: error },
    );
  }
}

/**
 * Decodes a complete NUL-terminated Git record stream without filename loss.
 */
function splitFingerprintNul(output: string): string[] {
  if (output.length === 0) return [];
  if (!output.endsWith("\u0000")) {
    throw new Error("Git returned non-NUL-terminated fingerprint output.");
  }
  return output.slice(0, -1).split("\u0000");
}

/**
 * Parses no-rename porcelain records into validated status/path pairs.
 *
 * `git status` reports repo-root-relative paths even when scoped with a `-- .`
 * pathspec, so `prefix` (the subtree prefix from `git rev-parse --show-prefix`)
 * is stripped to re-base each path onto the subtree before the openwiki/ignore
 * filters see it. `prefix` is empty for unscoped runs, leaving paths untouched.
 */
function parseFingerprintStatus(
  output: string,
  prefix = "",
): SourceStatusEntry[] {
  return splitFingerprintNul(output).map((record) => {
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("Git returned malformed porcelain status output.");
    }
    return {
      code: record.slice(0, 2),
      path: assertFingerprintGitPath(
        stripFingerprintPrefix(record.slice(3), prefix),
      ),
    };
  });
}

/**
 * Re-bases a repo-root-relative status path onto the subtree by removing its
 * prefix. A path outside the prefix (not expected under a `-- .` pathspec) is
 * returned unchanged rather than silently corrupted.
 */
function stripFingerprintPrefix(value: string, prefix: string): string {
  if (prefix && value.startsWith(prefix)) {
    return value.slice(prefix.length);
  }
  return value;
}

/**
 * Validates and normalizes one repository-relative path emitted by Git.
 */
function assertFingerprintGitPath(value: string): string {
  if (!value || path.posix.isAbsolute(value)) {
    throw new Error(`Git returned an invalid repository path: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Git returned an escaping repository path: ${value}`);
  }
  return normalized;
}

/**
 * Selects model-visible source paths while always retaining `.openwikiignore`.
 */
function isFingerprintSourcePath(
  candidate: string,
  openWikiIgnore: OpenWikiIgnore,
): boolean {
  if (candidate === OPENWIKI_IGNORE_FILE) return true;
  if (candidate === ".git" || candidate.startsWith(".git/")) return false;
  return !isOpenWikiPath(candidate) && !openWikiIgnore.ignores(candidate);
}

/**
 * Tests whether a fingerprint candidate exists without following symlinks.
 */
async function fingerprintEntryExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }
}

/**
 * Adds one source entry's path, kind, mode, and raw content to the hash.
 */
async function updateFingerprintSourceEntry(
  hash: ReturnType<typeof createHash>,
  cwd: string,
  sourcePath: string,
  tracked: boolean,
): Promise<void> {
  const absoluteRoot = path.resolve(cwd);
  const absolutePath = path.resolve(absoluteRoot, sourcePath);
  if (!absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(
      `Source fingerprint path escaped the repository: ${sourcePath}`,
    );
  }

  updateFingerprintField(hash, "path", sourcePath);

  let stats: BigIntStats;
  try {
    stats = await lstat(absolutePath, { bigint: true });
  } catch (error) {
    if (tracked && isFileNotFoundError(error)) {
      updateFingerprintField(hash, "kind", "tracked-missing");
      return;
    }
    throw new Error(`Unable to inspect source path ${sourcePath}.`, {
      cause: error,
    });
  }

  if (stats.isFile()) {
    const file = await readFingerprintRegularFile(
      absolutePath,
      sourcePath,
      stats,
    );
    updateFingerprintField(hash, "executable", file.executable ? "yes" : "no");
    updateFingerprintField(hash, "kind", "file");
    updateFingerprintField(hash, "bytes", file.bytes);
    return;
  }

  updateFingerprintField(
    hash,
    "executable",
    (stats.mode & 0o111n) !== 0n ? "yes" : "no",
  );
  if (stats.isSymbolicLink()) {
    updateFingerprintField(hash, "kind", "symlink");
    updateFingerprintField(
      hash,
      "target",
      await readlink(absolutePath, { encoding: "buffer" }),
    );
    return;
  }
  if (stats.isDirectory()) {
    // A tracked gitlink is represented by its repository path, HEAD/index
    // status, and directory kind. Normal untracked directories are expanded by
    // git ls-files --others into their contained files.
    updateFingerprintField(hash, "kind", "directory");
    return;
  }
  throw new Error(`Unsupported source entry type at ${sourcePath}.`);
}

/**
 * Reads one regular source file through a verified, non-following descriptor.
 *
 * The descriptor identity must match the entry inspected by `lstat`. This
 * closes the check/read window even when the platform does not expose
 * `O_NOFOLLOW`: a replacement symlink may be opened, but its target bytes are
 * never read because its device/inode identity cannot match the inspected file.
 *
 * @param absolutePath - Absolute repository path selected for fingerprinting.
 * @param sourcePath - Repository-relative path used in bounded errors.
 * @param inspectedStats - Non-following metadata captured before opening.
 * @returns Raw bytes and executable state from the verified descriptor.
 */
async function readFingerprintRegularFile(
  absolutePath: string,
  sourcePath: string,
  inspectedStats: BigIntStats,
): Promise<{ bytes: Buffer; executable: boolean }> {
  let fileHandle;
  try {
    fileHandle = await open(absolutePath, getFingerprintFileOpenFlags());
  } catch (error) {
    throw new Error(`Unable to safely open source path ${sourcePath}.`, {
      cause: error,
    });
  }

  try {
    const openedStats = await fileHandle.stat({ bigint: true });
    if (
      !openedStats.isFile() ||
      openedStats.dev !== inspectedStats.dev ||
      openedStats.ino !== inspectedStats.ino
    ) {
      throw new Error(
        `Source path changed while fingerprinting ${sourcePath}.`,
      );
    }

    return {
      bytes: await fileHandle.readFile(),
      executable: (openedStats.mode & 0o111n) !== 0n,
    };
  } finally {
    await fileHandle.close();
  }
}

/**
 * Builds read-only file flags that reject a final-component symlink when the
 * host platform supports that guarantee.
 *
 * @returns Numeric flags for opening a fingerprint source file.
 */
function getFingerprintFileOpenFlags(): number {
  return (
    fsConstants.O_RDONLY |
    (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0)
  );
}

/**
 * Appends one length-delimited field to the source fingerprint hash.
 */
function updateFingerprintField(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: string | Buffer,
): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  hash.update(label, "utf8");
  hash.update("\u0000");
  hash.update(String(bytes.length), "utf8");
  hash.update("\u0000");
  hash.update(bytes);
  hash.update("\u0000");
}

/**
 * Orders fingerprint strings by deterministic UTF-16 code-unit comparison.
 */
function compareFingerprintStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function getMetadataFilePath(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): string {
  return outputMode === "local-wiki"
    ? path.join(cwd, LOCAL_WIKI_METADATA_PATH)
    : path.join(cwd, UPDATE_METADATA_PATH);
}

/**
 * Excludes OpenWiki-owned metadata from content snapshots.
 */
function isIgnoredSnapshotPath(relativePath: string): boolean {
  return (
    relativePath === path.basename(UPDATE_METADATA_PATH) ||
    relativePath === LOCAL_WIKI_METADATA_PATH ||
    relativePath === REPOSITORY_RUN_STATE_BASENAME ||
    relativePath === WORKSPACES_STATE_BASENAME
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

  return [PAGE_MANIFEST_PATH, UPDATE_METADATA_PATH].some(
    (metadataPath) =>
      normalizedPath === metadataPath ||
      normalizedPath.endsWith(` -> ${metadataPath}`),
  );
}

/**
 * Returns best-effort repository-relative paths for planner context.
 *
 * Unlike the source fingerprint, history lookup failures intentionally produce
 * an empty list and do not weaken lifecycle correctness.
 */
export async function getRepositoryChangedPaths(
  cwd: string,
  openWikiIgnore: OpenWikiIgnore,
  baseGitHead?: string,
  scope?: GitScope,
): Promise<string[]> {
  const paths = new Set<string>();
  const { relative, pathspec } = gitScopeArgs(scope, true);

  if (baseGitHead) {
    for (const candidate of await runGitLines(cwd, [
      "diff",
      "--name-only",
      ...relative,
      `${baseGitHead}..HEAD`,
      ...pathspec,
    ])) {
      paths.add(normalizeGitPath(candidate));
    }
  }

  // Staged + unstaged tracked changes relative to HEAD.
  for (const candidate of await runGitLines(cwd, [
    "diff",
    "--name-only",
    ...relative,
    "HEAD",
    ...pathspec,
  ])) {
    paths.add(normalizeGitPath(candidate));
  }

  // Untracked files (ls-files output is already cwd-relative; the pathspec keeps
  // it scoped and, for the root, drops nested openwiki subtrees).
  for (const candidate of await runGitLines(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
    ...pathspec,
  ])) {
    paths.add(normalizeGitPath(candidate));
  }

  return [...paths]
    .filter(Boolean)
    .filter((candidate) => !isOpenWikiPath(candidate))
    .filter((candidate) => !openWikiIgnore.ignores(candidate))
    .sort(compareFingerprintStrings);
}

/**
 * Runs a best-effort Git query and returns its non-empty output lines.
 */
async function runGitLines(cwd: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["--no-pager", ...args], {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // Changed-path context is planner assistance, not a correctness boundary.
    // Claims preflight and the planner still run when history cannot be read.
    return [];
  }
}

async function getChangedPathsSinceLastUpdate(
  cwd: string,
  gitHead: string,
  scope?: GitScope,
): Promise<string[]> {
  const { relative, pathspec } = gitScopeArgs(scope, true);
  const diff = await runGit(cwd, [
    "diff",
    "--name-only",
    ...relative,
    `${gitHead}..HEAD`,
    ...pathspec,
  ]);

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
 * Whether a single line of git output names at least one ignored path.
 */
function lineReferencesIgnoredPath(
  line: string,
  openWikiIgnore: OpenWikiIgnore,
): boolean {
  return extractGitPaths(line).some((changedPath) =>
    openWikiIgnore.ignores(changedPath),
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
