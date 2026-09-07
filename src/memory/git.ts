import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { OpenWikiIgnore } from "../agent/openwiki-ignore.js";
import { formatRepositoryEvidenceResource } from "../claims/evidence/repository/resource.js";

/**
 * Maximum output retained from one Git query before reporting an unavailable layer.
 */
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Maximum duration of one local Git query.
 */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Complete SHA-1 or SHA-256 commit identity recorded by OpenWiki.
 */
const COMMIT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/**
 * A comparison gap whose explanation can be returned without raw Git diagnostics.
 */
export class MemoryComparisonError extends Error {
  /**
   * Creates safe feedback about unavailable source history or working files.
   *
   * @param message - Explanation suitable for a memory layer's unavailable field.
   */
  constructor(message: string) {
    super(message);
    this.name = "MemoryComparisonError";
  }
}

/**
 * One net file change, without staging or commit-origin labels.
 */
export interface GitMemoryChange {
  /**
   * Repository-relative source path, with renames represented as deletion and addition.
   */
  path: string;
}

/**
 * Read-only Git comparisons against captured commit identities and the working tree.
 */
export class MemoryGit {
  /**
   * Creates a request-local Git reader without fetching or changing repository state.
   *
   * @param root - Absolute repository root.
   * @param ignore - Existing repository source visibility rules.
   */
  constructor(
    private readonly root: string,
    private readonly ignore: OpenWikiIgnore,
  ) {}

  /**
   * Resolves the current checkout commit, including a detached HEAD.
   *
   * @returns Captured commit identity.
   */
  async head(): Promise<string> {
    const head = await this.resolveCommit("HEAD");
    if (!head)
      throw new MemoryComparisonError(
        "The checkout has no commit available in local Git history.",
      );
    return head;
  }

  /**
   * Resolves the locally known default branch without treating a feature branch as main.
   *
   * Origin's symbolic default takes precedence over conventional main/master names.
   * Comparable local and remote-tracking tips use the newer commit; divergence is
   * reported instead of guessing which source history is authoritative.
   *
   * @returns Captured default-branch commit identity.
   */
  async main(): Promise<string> {
    const symbolic = (
      await this.run(
        ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
        [0, 1],
      )
    )
      .toString("utf8")
      .trim();
    const names = symbolic.startsWith("refs/remotes/origin/")
      ? [symbolic.slice("refs/remotes/origin/".length)]
      : ["main", "master"];
    for (const name of names) {
      const [local, remote] = await Promise.all([
        this.resolveCommit(`refs/heads/${name}`),
        this.resolveCommit(`refs/remotes/origin/${name}`),
      ]);
      if (!local && !remote) continue;
      if (!local) return remote!;
      if (!remote || local === remote) return local;
      const common = await this.mergeBase(local, remote);
      if (common === remote) return local;
      if (common === local) return remote;
      throw new MemoryComparisonError(
        "The local default branch and its origin tracking branch have diverged. Resolve which main history to use before retrying.",
      );
    }
    throw new MemoryComparisonError(
      "No locally known main branch is available. Fetch the default branch and retry; retrieval does not fetch automatically.",
    );
  }

  /**
   * Resolves a persisted wiki checkpoint strictly as a commit hash.
   *
   * @param checkpoint - Commit identity recorded by the completed wiki page or update.
   * @returns Commit available in local history.
   */
  async checkpoint(checkpoint: string | undefined): Promise<string> {
    if (!checkpoint || !COMMIT_ID_PATTERN.test(checkpoint)) {
      throw new MemoryComparisonError(
        "The wiki has no valid source checkpoint. Update it to establish a Git baseline.",
      );
    }
    const commit = await this.resolveCommit(checkpoint);
    if (!commit)
      throw new MemoryComparisonError(
        "The wiki checkpoint is missing from local Git history. Fetch the required history and retry.",
      );
    return commit;
  }

  /**
   * Finds a unique shared-history boundary without comparing unrelated branch tips.
   *
   * @param left - First resolved commit.
   * @param right - Second resolved commit.
   * @returns Unique common ancestor used as a comparison baseline.
   */
  async mergeBase(left: string, right: string): Promise<string> {
    const output = await this.run(["merge-base", "--all", left, right], [0, 1]);
    const bases = output.toString("utf8").trim().split("\n").filter(Boolean);
    if (bases.length !== 1)
      throw new MemoryComparisonError(
        "A unique shared Git history could not be established. Fetch missing history or resolve the branch history before retrying.",
      );
    return bases[0];
  }

  /**
   * Checks incorporation of every main commit contributing to a resource's change.
   *
   * @param base - Main history already covered by the wiki.
   * @param main - Captured default-branch tip.
   * @param head - Captured checkout tip.
   * @param resourcePath - Changed repository-relative path.
   * @returns Whether all contributing main history is reachable from the checkout.
   */
  async inCheckout(
    base: string,
    main: string,
    head: string,
    resourcePath: string,
  ): Promise<boolean> {
    const missing = await this.run([
      "rev-list",
      "--full-history",
      `${base}..${main}`,
      "--not",
      head,
      "--",
      resourcePath,
    ]);
    return missing.length === 0;
  }

  /**
   * Enumerates net visible source changes without materializing patches.
   *
   * @param base - Shared-history commit at the start of the comparison.
   * @param target - Main commit, or undefined for the resulting working tree.
   * @param relevantPaths - Optional evidence-path filter applied before inspecting files.
   * @returns Stable path order with generated and ignored files excluded.
   */
  async changes(
    base: string,
    target: string | undefined,
    relevantPaths?: ReadonlySet<string>,
  ): Promise<GitMemoryChange[]> {
    if (!target && (await this.run(["ls-files", "--unmerged", "-z"])).length) {
      throw new MemoryComparisonError(
        "The working tree has unresolved merge conflicts. Resolve them before comparing working memory.",
      );
    }
    const endpoints = target ? [base, target] : [base];
    const changed = splitNul(
      await this.run([
        "diff",
        "--name-only",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        ...endpoints,
        "--",
      ]),
    );
    const untracked = new Set(
      target
        ? []
        : splitNul(
            await this.run([
              "ls-files",
              "--others",
              "--exclude-standard",
              "-z",
            ]),
          ),
    );
    const paths = [...new Set([...changed, ...untracked])]
      .filter(
        (file) =>
          this.visible(file) && (!relevantPaths || relevantPaths.has(file)),
      )
      .sort();
    const changes: GitMemoryChange[] = [];
    for (const file of paths) {
      if (!target) await this.assertWorkingPath(file);
      if (untracked.has(file) && !(await this.untrackedChanged(base, file)))
        continue;
      changes.push({ path: file });
    }
    return changes;
  }

  /**
   * Reads a regular file from a captured commit without following filesystem links.
   *
   * @param commit - Resolved commit identity.
   * @param file - Literal repository-relative path.
   * @returns Committed UTF-8 content, or null if the path is absent or not a regular blob.
   */
  async fileAt(commit: string, file: string): Promise<string | null> {
    const entry = (
      await this.run(["ls-tree", "-z", commit, "--", file])
    ).toString("utf8");
    const match = /^100(?:644|755) blob ([a-f0-9]+)\t/u.exec(entry);
    return match
      ? (await this.run(["cat-file", "blob", match[1]])).toString("utf8")
      : null;
  }

  /**
   * Lists main-history revisions that changed a pending reflection's path.
   *
   * @param commit - Resolved main tip.
   * @param file - Literal repository-relative reflection path.
   * @returns Relevant commits, including historical additions and deletions.
   */
  async fileHistory(commit: string, file: string): Promise<string[]> {
    const output = await this.run([
      "log",
      "--full-history",
      "--format=%H",
      commit,
      "--",
      file,
    ]);
    return output.toString("utf8").trim().split("\n").filter(Boolean);
  }

  /**
   * Determines whether absent older reflection history can be ruled out locally.
   *
   * @returns Whether Git records shallow history boundaries in this repository.
   */
  async isShallow(): Promise<boolean> {
    return (
      (await this.run(["rev-parse", "--is-shallow-repository"]))
        .toString("utf8")
        .trim() === "true"
    );
  }

  /**
   * Resolves a ref without allowing revision text to become an option.
   *
   * @param ref - Fixed ref name or validated checkpoint hash.
   * @returns Resolved commit, or undefined when absent.
   */
  private async resolveCommit(ref: string): Promise<string | undefined> {
    const output = (
      await this.run(
        [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${ref}^{commit}`,
        ],
        [0, 1],
      )
    )
      .toString("utf8")
      .trim();
    return COMMIT_ID_PATTERN.test(output) ? output : undefined;
  }

  /**
   * Applies existing source exclusions before any path-specific content reads.
   *
   * @param file - Git-reported repository-relative path.
   * @returns Whether the resource belongs in repository memory.
   */
  private visible(file: string): boolean {
    if (
      file.toLowerCase() === "openwiki" ||
      file.toLowerCase().startsWith("openwiki/") ||
      this.ignore.ignores(file)
    )
      return false;
    try {
      formatRepositoryEvidenceResource({ path: file });
      return true;
    } catch {
      throw new MemoryComparisonError(
        "A changed source path cannot be represented as a repository evidence resource.",
      );
    }
  }

  /**
   * Prevents an intermediate working-tree symlink from redirecting a source read.
   *
   * @param file - Validated repository-relative source path.
   */
  private async assertWorkingPath(file: string): Promise<void> {
    const parts = file.split("/");
    let current = this.root;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      try {
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new MemoryComparisonError(
            "A working source path traverses a filesystem alias or non-directory.",
          );
      } catch (error) {
        if (isMissingFile(error)) return;
        throw error;
      }
    }
  }

  /**
   * Compares an untracked file with its baseline, including staged removals recreated locally.
   *
   * Git's ordinary tree-to-worktree diff follows index membership. Compare the
   * baseline content and mode directly to detect the final local state.
   *
   * @param base - Working comparison baseline.
   * @param file - Visible untracked source path.
   * @returns Whether the file's final content or mode differs from its baseline.
   */
  private async untrackedChanged(base: string, file: string): Promise<boolean> {
    const entry = (
      await this.run(["ls-tree", "-z", base, "--", file])
    ).toString("utf8");
    if (!entry) return true;
    const before = await this.run(["cat-file", "blob", `${base}:${file}`]);
    const absolute = path.join(this.root, file);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() && !metadata.isSymbolicLink()) {
      throw new MemoryComparisonError(
        "A working source is not a regular file or symbolic link.",
      );
    }
    if (metadata.size > MAX_GIT_OUTPUT_BYTES)
      throw new MemoryComparisonError(
        "A working source file exceeds the comparison size limit.",
      );
    const after = metadata.isSymbolicLink()
      ? Buffer.from(await readlink(absolute))
      : await readFile(absolute);
    const mode = metadata.isSymbolicLink()
      ? "120000"
      : metadata.mode & 0o111
        ? "100755"
        : "100644";
    return !before.equals(after) || !entry.startsWith(`${mode} `);
  }

  /**
   * Executes a bounded local Git read with hooks for external diff and filesystem monitors disabled.
   *
   * @param args - Literal argument vector; paths never pass through a shell.
   * @param allowedExitCodes - Expected statuses for successful or missing Git lookups.
   * @returns Raw standard output, retaining NUL delimiters and binary blob bytes.
   */
  private run(
    args: readonly string[],
    allowedExitCodes: readonly number[] = [0],
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        [
          "--no-pager",
          "--no-optional-locks",
          "--literal-pathspecs",
          "-c",
          "core.fsmonitor=false",
          ...args,
        ],
        {
          cwd: this.root,
          encoding: "buffer",
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          timeout: GIT_TIMEOUT_MS,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
        (error, stdout) => {
          if (
            error &&
            (!allowedExitCodes.includes(Number(error.code)) || error.killed)
          ) {
            reject(
              new MemoryComparisonError(
                "The local Git comparison failed or exceeded its output or time limit. Check repository history and working files before retrying.",
              ),
            );
            return;
          }
          resolve(stdout);
        },
      );
    });
  }
}

/**
 * Splits Git's lossless path output without trimming spaces in filenames.
 *
 * @param output - NUL-delimited Git output.
 * @returns Complete non-empty path records.
 */
function splitNul(output: Buffer): string[] {
  return output.toString("utf8").split("\0").filter(Boolean);
}

/**
 * Recognizes a deleted working-tree ancestor during containment inspection.
 *
 * @param error - Unknown filesystem error.
 * @returns Whether the ancestor no longer exists.
 */
function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
