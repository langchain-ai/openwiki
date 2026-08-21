import path from "node:path";
import {
  LocalShellBackend,
  type DeleteResult,
  type EditResult,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileUploadResponse,
  type GlobResult,
  type GrepResult,
  type LocalShellBackendOptions,
  type LsResult,
  type ReadRawResult,
  type ReadResult,
  type WriteResult,
} from "deepagents";
import { OPEN_WIKI_DIR } from "../config/constants.js";
import { OPENWIKI_IGNORE_FILE, OpenWikiIgnore } from "./openwiki-ignore.js";
import type { OpenWikiOutputMode } from "./types.js";

/**
 * ToolMessage metadata key under which a successful mutation records the path it wrote.
 */
export const MUTATION_PATH_METADATA_KEY = "openwikiMutationPath";

/**
 * Options for {@link OpenWikiLocalShellBackend}, extending the deepagents shell backend options.
 */
type OpenWikiBackendOptions = LocalShellBackendOptions & {
  /**
   * Confine writes to the `openwiki/` docs tree.
   *
   * @default false
   */
  docsOnly?: boolean;

  /**
   * Rules that exclude paths from all agent filesystem/shell access.
   *
   * @default an inactive ruleset (no exclusions)
   */
  openWikiIgnore?: OpenWikiIgnore;

  /**
   * The doc-generation output target, which relaxes the docs-only write check
   * for `local-wiki` runs.
   *
   * @default "repository"
   */
  outputMode?: OpenWikiOutputMode;
};

/**
 * Shell commands the agent may still run while `.openwikiignore` rules are active.
 *
 * This is a deliberate allowlist, not a denylist. While rules are active we
 * cannot statically prove what an arbitrary shell command reads (variable
 * expansion, command substitution, `find -exec`, `cd` + relative paths,
 * `git show HEAD:<path>`, and so on all defeat naive command scanning), so the
 * safe default is to deny shell and permit only these few commands that the
 * agent workflow needs and that cannot exfiltrate an ignored path. Each entry
 * is fully anchored (`^...$`) so it cannot be prefixed or chained with a second
 * command. Discovery and reads must instead go through the gated filesystem
 * tools. See {@link isAllowedShellCommandWithIgnore}.
 */
const allowedIgnoredShellCommands = [
  /^pwd$/u,
  /^git\s+(?:--no-pager\s+)?rev-parse\s+HEAD$/u,
  /^rm\s+-f\s+(?:\.\/)?openwiki\/_plan\.md$/u,
];

/**
 * Determine whether a glob attempts unbounded discovery from the repository
 * root. OpenWiki prompts already prohibit this shape because it is expensive;
 * rejecting it in the backend also avoids upstream traversal of a worktree's
 * file-backed `.git` pointer as though it were a directory.
 *
 * @param pattern - Glob pattern supplied by the agent.
 * @param searchPath - Optional virtual search root.
 *
 * @returns Whether the request is an unbounded repository-root glob.
 */
function isBroadRootGlob(pattern: string, searchPath?: string): boolean {
  const searchesRoot =
    searchPath === undefined || searchPath === "" || searchPath === "/";
  const normalizedPattern = pattern.replace(/^\/+|\/+$/gu, "");

  return searchesRoot && ["**", "**/*", "**/**"].includes(normalizedPattern);
}

/**
 * Determine whether a glob explicitly targets Git's private metadata.
 *
 * @param pattern - Glob pattern supplied by the agent.
 * @param searchPath - Optional virtual search root.
 *
 * @returns Whether either input names a `.git` path component.
 */
function targetsGitMetadata(pattern: string, searchPath?: string): boolean {
  return [pattern, searchPath ?? ""].some((value) =>
    /(?:^|[\\/])\.git(?:[\\/]|$)/u.test(value),
  );
}

/**
 * Recognize the upstream worktree failure raised when a glob tries to scan the
 * file-backed `.git` pointer as a directory.
 *
 * @param error - Unknown failure raised by the underlying shell backend.
 *
 * @returns Whether the error is the specific recoverable worktree mismatch.
 */
function isWorktreeGitScandirError(error: unknown): boolean {
  const candidate = error as NodeJS.ErrnoException;

  return (
    candidate?.code === "ENOTDIR" &&
    typeof candidate.path === "string" &&
    /(?:^|[\\/])\.git$/u.test(candidate.path)
  );
}

/**
 * Determines whether a shell command explicitly references repository Claims state.
 *
 * This is defense in depth for state already hidden from filesystem discovery,
 * not a general-purpose shell parser.
 *
 * @param command - Shell command requested by the model.
 * @returns Whether the command names the OpenWiki Claims directory.
 */
function referencesClaimsState(command: string): boolean {
  const normalized = command.replaceAll("\\", "/").toLowerCase();

  return /(?:^|[/\s'"`=;|&()])openwiki\/\.claims(?:\/|[\s'"`=;|&()]|$)/u.test(
    normalized,
  );
}

/**
 * Filesystem/shell backend that enforces OpenWiki's access boundaries for the
 * doc-generation agent.
 *
 * It wraps the deepagents `LocalShellBackend` and layers on three independent
 * constraints:
 *
 * 1. `.openwikiignore` exclusion: reads/writes/edits of an ignored path are hard
 *    denied with an error; discovery tools (`ls`/`glob`/`grep`) silently drop
 *    ignored entries; uploads/downloads reject ignored paths; and shell
 *    `execute` is restricted to a small allowlist while any rule is active.
 * 2. Docs-only confinement (`docsOnly`): in repository mode, writes are limited
 *    to the `openwiki/` tree via {@link isOpenWikiDocsPath}.
 * 3. Claims ownership: repository `.claims` sidecars are hidden from generic
 *    tools and may only be accessed by OpenWiki's direct persistence layer.
 *
 * All three are security boundaries against an agent that may be prompt-injected via
 * untrusted repository content, so path checks canonicalize before matching.
 */
export class OpenWikiLocalShellBackend extends LocalShellBackend {
  /**
   * Whether writes are confined to the `openwiki/` docs tree (repository mode).
   */
  private readonly docsOnly: boolean;

  /**
   * The active `.openwikiignore` ruleset gating every path this backend touches.
   */
  private readonly openWikiIgnore: OpenWikiIgnore;

  /**
   * The doc-generation output target; `local-wiki` relaxes the docs-only write check.
   */
  private readonly outputMode: OpenWikiOutputMode;

  constructor(options: OpenWikiBackendOptions) {
    super(options);
    this.docsOnly = options.docsOnly === true;
    this.openWikiIgnore = options.openWikiIgnore ?? new OpenWikiIgnore([]);
    this.outputMode = options.outputMode ?? "repository";
  }

  /**
   * Read a file, hard-denying the read if the path is excluded by `.openwikiignore`.
   */
  override async read(
    filePath: string,
    offset?: number,
    limit?: number,
  ): Promise<ReadResult> {
    const error =
      this.getIgnoredPathError(filePath) ??
      this.getClaimsOwnershipError(filePath);

    if (error) {
      return { error };
    }

    return super.read(filePath, offset, limit);
  }

  /**
   * Read raw bytes, hard-denying the read if the path is excluded by `.openwikiignore`.
   */
  override async readRaw(filePath: string): Promise<ReadRawResult> {
    const error =
      this.getIgnoredPathError(filePath) ??
      this.getClaimsOwnershipError(filePath);

    if (error) {
      return { error };
    }

    return super.readRaw(filePath);
  }

  /**
   * Write a file, denying if the path is excluded by `.openwikiignore` or falls
   * outside the docs tree in docs-only mode. On success, records the mutated
   * path in the result metadata for the validator.
   */
  override async write(
    filePath: string,
    content: string,
  ): Promise<WriteResult> {
    const error =
      this.getIgnoredPathError(filePath) ??
      this.getClaimsOwnershipError(filePath) ??
      this.getDocsOnlyWriteError(filePath);

    if (error) {
      return { error };
    }

    return markMutation(await super.write(filePath, content), filePath);
  }

  /**
   * Edit a file in place, applying the same `.openwikiignore` and docs-only
   * checks as {@link write} and recording the mutated path on success.
   */
  override async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    const error =
      this.getIgnoredPathError(filePath) ??
      this.getClaimsOwnershipError(filePath) ??
      this.getDocsOnlyWriteError(filePath);

    if (error) {
      return { error };
    }

    return markMutation(
      await super.edit(filePath, oldString, newString, replaceAll),
      filePath,
    );
  }

  /**
   * Deletes a generated file while enforcing ignore, ownership, and docs-only rules.
   *
   * @param filePath - Virtual file path to delete.
   * @returns Backend deletion result with mutation metadata on success.
   */
  override async delete(filePath: string): Promise<DeleteResult> {
    const error =
      this.getIgnoredPathError(filePath) ??
      this.getClaimsOwnershipError(filePath) ??
      this.getDocsOnlyWriteError(filePath);
    if (error) {
      return { error };
    }
    return markMutation(await super.delete(filePath), filePath);
  }

  /**
   * List a directory, denying if the directory itself is excluded and otherwise
   * filtering out any ignored entries so they never surface to the agent.
   */
  override async ls(dirPath: string): Promise<LsResult> {
    const error =
      this.getIgnoredPathError(dirPath, true) ??
      this.getClaimsOwnershipError(dirPath);

    if (error) {
      return { error };
    }

    const result = await super.ls(dirPath);

    return {
      ...result,
      files: result.files?.filter(
        (file) =>
          !this.openWikiIgnore.ignores(file.path, file.is_dir === true) &&
          !this.isClaimsPath(file.path),
      ),
    };
  }

  /**
   * Search file contents, short-circuiting to no matches if the search root is
   * an ignored directory and filtering out matches under any ignored path.
   */
  override async grep(
    pattern: string,
    dirPath?: string | null,
    glob?: string | null,
  ): Promise<GrepResult> {
    if (
      dirPath &&
      (this.openWikiIgnore.ignores(dirPath, true) || this.isClaimsPath(dirPath))
    ) {
      return { matches: [] };
    }

    const result = await super.grep(pattern, dirPath ?? undefined, glob);

    return {
      ...result,
      matches: result.matches?.filter(
        (match) =>
          !this.openWikiIgnore.ignores(match.path) &&
          !this.isClaimsPath(match.path),
      ),
    };
  }

  /**
   * Expand a glob, short-circuiting to no results if the search root is an
   * ignored directory and filtering out any ignored files from the results.
   */
  override async glob(
    pattern: string,
    searchPath?: string,
  ): Promise<GlobResult> {
    if (isBroadRootGlob(pattern, searchPath)) {
      return {
        error:
          "Unbounded root globbing is disabled. Use ls at the repository root, then targeted glob or grep calls by directory and extension.",
      };
    }

    if (targetsGitMetadata(pattern, searchPath)) {
      return {
        error:
          "Git metadata is private repository state and is unavailable to glob. Use `git rev-parse HEAD` when the current commit is needed.",
      };
    }

    if (searchPath && this.isClaimsPath(searchPath)) {
      return { files: [] };
    }

    if (searchPath && this.openWikiIgnore.ignores(searchPath, true)) {
      return { files: [] };
    }

    let result: GlobResult;

    try {
      result = await super.glob(pattern, searchPath);
    } catch (error) {
      if (isWorktreeGitScandirError(error)) {
        return {
          error:
            "Glob could not traverse this Git worktree safely. Use ls at the repository root, then search a specific source directory.",
        };
      }

      throw error;
    }

    return {
      ...result,
      files: result.files?.filter(
        (file) =>
          !this.openWikiIgnore.ignores(file.path, file.is_dir === true) &&
          !this.isClaimsDiscoveryPath(file.path, searchPath),
      ),
    };
  }

  /**
   * Upload files, returning `permission_denied` for any path that is excluded by
   * `.openwikiignore` or (in docs-only mode) falls outside the `openwiki/` tree,
   * while still uploading the allowed ones. As a write path, this enforces the
   * same docs-only confinement as {@link write}/{@link edit}. Results are
   * returned in the original input order.
   */
  override async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const allowedFiles = files.filter(
      ([filePath]) => !this.isWriteBlocked(filePath),
    );

    if (allowedFiles.length === files.length) {
      return super.uploadFiles(files);
    }

    const allowedResults = await super.uploadFiles(allowedFiles);
    const resultsByPath = new Map(
      allowedResults.map((result) => [result.path, result]),
    );

    return files.map(([filePath]) => {
      if (this.isWriteBlocked(filePath)) {
        return { error: "permission_denied", path: filePath };
      }

      return (
        resultsByPath.get(filePath) ?? { error: "invalid_path", path: filePath }
      );
    });
  }

  /**
   * Download files, returning `permission_denied` for any ignored path while
   * still downloading the allowed ones. Results preserve the input order.
   */
  override async downloadFiles(
    paths: string[],
  ): Promise<FileDownloadResponse[]> {
    const allowedPaths = paths.filter(
      (filePath) =>
        !this.openWikiIgnore.ignores(filePath) && !this.isClaimsPath(filePath),
    );

    if (allowedPaths.length === paths.length) {
      return super.downloadFiles(paths);
    }

    const allowedResults = await super.downloadFiles(allowedPaths);
    const resultsByPath = new Map(
      allowedResults.map((result) => [result.path, result]),
    );

    return paths.map((filePath) => {
      if (
        this.openWikiIgnore.ignores(filePath) ||
        this.isClaimsPath(filePath)
      ) {
        return { content: null, error: "permission_denied", path: filePath };
      }

      return (
        resultsByPath.get(filePath) ?? {
          content: null,
          error: "invalid_path",
          path: filePath,
        }
      );
    });
  }

  /**
   * Run a shell command. While any `.openwikiignore` rule is active, only the
   * {@link allowedIgnoredShellCommands} allowlist may run; anything else is
   * refused (exit code 1) with guidance to use the gated filesystem tools,
   * since arbitrary shell cannot be proven not to read an ignored path.
   */
  override async execute(command: string): Promise<ExecuteResponse> {
    if (this.outputMode === "repository" && referencesClaimsState(command)) {
      return {
        exitCode: 1,
        output:
          "OpenWiki Claims state is implementation-owned and unavailable to shell execute. Use inspect_claims and resolve_claims.",
        truncated: false,
      };
    }

    if (
      this.openWikiIgnore.isActive &&
      !isAllowedShellCommandWithIgnore(command)
    ) {
      return {
        exitCode: 1,
        output: `Shell execute is restricted while ${OPENWIKI_IGNORE_FILE} is active. Use the file tools instead (read_file, ls, glob, grep) so ignored paths stay excluded.`,
        truncated: false,
      };
    }

    return super.execute(command);
  }

  /**
   * Return a refusal message when a write escapes the docs tree in docs-only
   * mode, or `null` if the write is allowed. Always allows in `local-wiki` mode
   * or when the path is under `openwiki/`.
   */
  private getDocsOnlyWriteError(filePath: string): string | null {
    if (
      !this.docsOnly ||
      this.outputMode === "local-wiki" ||
      isOpenWikiDocsPath(filePath)
    ) {
      return null;
    }

    return `OpenWiki repository init/update runs may only write under /${OPEN_WIKI_DIR}/. Refused path: ${filePath}`;
  }

  /**
   * Return a refusal message when a path is excluded by `.openwikiignore`, or
   * `null` if it is allowed.
   */
  private getIgnoredPathError(
    filePath: string,
    isDirectory = false,
  ): string | null {
    if (!this.openWikiIgnore.ignores(filePath, isDirectory)) {
      return null;
    }

    return `Path is excluded by ${OPENWIKI_IGNORE_FILE}: ${filePath}`;
  }

  /**
   * Returns a refusal when a repository path resolves inside Claims state.
   *
   * @param filePath - Candidate virtual repository path.
   * @returns Ownership error, or `null` when generic access is allowed.
   */
  private getClaimsOwnershipError(filePath: string): string | null {
    if (!this.isClaimsPath(filePath)) {
      return null;
    }

    return `OpenWiki Claims state is implementation-owned: ${filePath}`;
  }

  /**
   * Determines whether a path is reserved Claims state for this output mode.
   *
   * @param filePath - Candidate virtual path.
   * @returns Whether the repository Claims boundary applies.
   */
  private isClaimsPath(filePath: string): boolean {
    return this.outputMode === "repository" && isClaimsStatePath(filePath);
  }

  /**
   * Resolves search-relative glob results before checking Claims ownership.
   *
   * @param filePath - Path returned by the underlying discovery operation.
   * @param searchPath - Virtual discovery root.
   * @returns Whether the discovered entry belongs to Claims state.
   */
  private isClaimsDiscoveryPath(
    filePath: string,
    searchPath?: string,
  ): boolean {
    if (this.isClaimsPath(filePath)) {
      return true;
    }
    if (!searchPath || searchPath === "/") {
      return false;
    }

    return this.isClaimsPath(
      path.posix.join(searchPath.replaceAll("\\", "/"), filePath),
    );
  }

  /**
   * Whether writing to a path is disallowed, combining the `.openwikiignore`
   * exclusion and the docs-only confinement checks that {@link write} and
   * {@link edit} apply. Used by batch write paths that cannot short-circuit on a
   * single error message.
   */
  private isWriteBlocked(filePath: string): boolean {
    return (
      this.openWikiIgnore.ignores(filePath) ||
      this.isClaimsPath(filePath) ||
      this.getDocsOnlyWriteError(filePath) !== null
    );
  }
}

/**
 * Carries a successful mutation's file path into the ToolMessage metadata used by the validator.
 */
function markMutation<Result extends WriteResult | EditResult | DeleteResult>(
  result: Result,
  filePath: string,
): Result {
  const mutableResult = result as Result & {
    metadata?: Record<string, unknown>;
  };
  if (!result.error) {
    mutableResult.metadata = {
      ...mutableResult.metadata,
      [MUTATION_PATH_METADATA_KEY]: result.path ?? filePath,
    };
  }
  return mutableResult;
}

/**
 * Determines whether a virtual path resolves inside OpenWiki-owned Claims state.
 *
 * @param filePath - Candidate virtual repository path.
 * @returns Whether the normalized path is the Claims directory or its descendant.
 */
export function isClaimsStatePath(filePath: string): boolean {
  const normalized = path.posix
    .normalize(filePath.replaceAll("\\", "/"))
    .toLowerCase();
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;

  return (
    absolute === "/openwiki/.claims" ||
    absolute.startsWith("/openwiki/.claims/")
  );
}

/**
 * Whether a path resolves to somewhere inside the `openwiki/` docs tree.
 *
 * The path is canonicalized (backslashes, leading slashes, and `.`/`..`
 * segments collapsed) before the prefix check so a path such as
 * `/openwiki/../AGENTS.md` cannot escape the confinement.
 */
export function isOpenWikiDocsPath(filePath: string): boolean {
  const slashed = filePath.trim().replace(/\\/gu, "/");
  // Collapse `..`/`.` segments before the prefix check so a path like
  // "/openwiki/../AGENTS.md" cannot escape the openwiki/ confinement.
  const normalized = path.posix.normalize(`/${slashed.replace(/^\/+/u, "")}`);
  const virtualPath = normalized.replace(/^\/+/u, "");

  return (
    virtualPath === OPEN_WIKI_DIR || virtualPath.startsWith(`${OPEN_WIKI_DIR}/`)
  );
}

/**
 * Whether a shell command is on the {@link allowedIgnoredShellCommands} allowlist
 * and may therefore run while `.openwikiignore` rules are active.
 */
function isAllowedShellCommandWithIgnore(command: string): boolean {
  const trimmedCommand = command.trim();

  return allowedIgnoredShellCommands.some((allowedCommand) =>
    allowedCommand.test(trimmedCommand),
  );
}
