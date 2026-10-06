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
import { OPEN_WIKI_VIRTUAL_DIR } from "../config/constants.js";
import { normalizeRepositoryWikiDirectory } from "../config/wiki-directory.js";
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
   * Confine writes to the configured wiki docs tree.
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

  /**
   * Exact generated pages this backend may mutate in repository docs-only mode.
   *
   * `undefined` preserves the existing repository writer behavior. An empty
   * array creates a read-only generated-docs backend.
   */
  writableWikiPages?: readonly string[];

  /**
   * Physical repository-relative directory that stores generated wiki files.
   */
  wikiDirectory?: string;
};

/**
 * Shell commands the agent may run.
 *
 * This is a deliberate allowlist, not a denylist. `LocalShellBackend` runs
 * commands directly on the host, so its `rootDir` and `virtualMode` options do
 * not confine shell execution. We cannot statically prove an arbitrary shell
 * command is workspace-safe (variable expansion, command substitution,
 * `find -exec`, `cd` + relative paths, and so on all defeat naive command
 * scanning). Permit only the few commands that the agent workflow needs and
 * that cannot read outside the workspace. Each entry is fully anchored
 * (`^...$`) so it cannot be prefixed or chained with a second command.
 * Discovery and reads must instead go through the gated filesystem tools. See
 * {@link isAllowedShellCommand}.
 */
const allowedShellCommands = [
  /^pwd$/u,
  /^git[ \t]+(?:--no-pager[ \t]+)?rev-parse[ \t]+HEAD$/u,
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
 * Process-local serialization of file operations, keyed by host path.
 *
 * LangChain runs every tool call of one model turn concurrently, and the
 * upstream filesystem backend neither locks nor writes atomically: `write`
 * truncates before writing and `edit` is a read-modify-write. Overlapping
 * operations on one page can leave a stale tail, drop an edit, or let a read
 * see the page empty between truncate and write. The queue is module-level
 * because page workers and the code-owned lifecycle each build their own
 * backend over the same files.
 */
const pathOperations = new Map<string, Promise<void>>();

/**
 * Runs one file operation after every earlier operation on the same file.
 *
 * Callers must call this before their first `await` so operations issued
 * together run in the order they were issued.
 *
 * @param rootDir - Absolute backend root the virtual path resolves under.
 * @param filePath - Virtual path the operation reads or writes.
 * @param operation - File operation to run once it holds the file.
 * @returns The operation's result.
 */
async function withPathOperation<T>(
  rootDir: string,
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const hostPath = path.join(rootDir, normalizeVirtualPath(filePath));
  const previous = pathOperations.get(hostPath) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  pathOperations.set(hostPath, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (pathOperations.get(hostPath) === current) {
      pathOperations.delete(hostPath);
    }
  }
}

/**
 * Filesystem/shell backend that enforces OpenWiki's access boundaries for the
 * doc-generation agent.
 *
 * It wraps the deepagents `LocalShellBackend` and layers on five independent
 * constraints:
 *
 * 1. Shell confinement: shell `execute` is restricted to a small allowlist because
 *    the upstream local shell backend otherwise runs commands directly on the host.
 * 2. `.openwikiignore` exclusion: reads/writes/edits of an ignored path are hard
 *    denied with an error; discovery tools (`ls`/`glob`/`grep`) silently drop
 *    ignored entries; and uploads/downloads reject ignored paths.
 * 3. Docs-only confinement (`docsOnly`): in repository mode, writes are limited
 *    to the configured wiki tree via {@link isOpenWikiDocsPath}.
 * 4. Claims ownership: repository `.claims` sidecars are hidden from generic
 *    tools and may only be accessed by OpenWiki's direct persistence layer.
 * 5. Personal mode: shell execution is always denied, including delegated calls.
 *
 * These boundaries constrain an agent that may be prompt-injected via
 * untrusted repository content, so path checks canonicalize before matching.
 *
 * Reads and mutations of one file are also serialized across every instance,
 * so concurrent tool calls on a page apply in order (see
 * {@link withPathOperation}).
 */
export class OpenWikiLocalShellBackend extends LocalShellBackend {
  /**
   * Whether writes are confined to the configured wiki docs tree.
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

  /**
   * Canonical generated pages this worker may mutate, when explicitly scoped.
   */
  private readonly writableWikiPages?: ReadonlySet<string>;

  /**
   * Physical repository-relative directory allowed by docs-only confinement.
   */
  private readonly wikiDirectory: string;

  constructor(options: OpenWikiBackendOptions) {
    super(options);
    this.docsOnly = options.docsOnly === true;
    this.openWikiIgnore = options.openWikiIgnore ?? new OpenWikiIgnore([]);
    this.outputMode = options.outputMode ?? "repository";
    this.wikiDirectory = normalizeRepositoryWikiDirectory(
      options.wikiDirectory ?? OPEN_WIKI_VIRTUAL_DIR,
    );
    this.writableWikiPages = options.writableWikiPages
      ? new Set(
          options.writableWikiPages.map((page) =>
            normalizeVirtualPath(mapVirtualWikiPath(page, this.wikiDirectory)),
          ),
        )
      : undefined;
  }

  /**
   * Read a file, hard-denying the read if the path is excluded by `.openwikiignore`.
   */
  override async read(
    filePath: string,
    offset?: number,
    limit?: number,
  ): Promise<ReadResult> {
    const resolvedPath = this.resolveWikiPath(filePath);
    const error =
      this.getIgnoredPathError(resolvedPath) ??
      this.getClaimsOwnershipError(resolvedPath);

    if (error) {
      return { error };
    }

    return withPathOperation(this.cwd, resolvedPath, () =>
      super.read(resolvedPath, offset, limit),
    );
  }

  /**
   * Read raw bytes, hard-denying the read if the path is excluded by `.openwikiignore`.
   */
  override async readRaw(filePath: string): Promise<ReadRawResult> {
    const resolvedPath = this.resolveWikiPath(filePath);
    const error =
      this.getIgnoredPathError(resolvedPath) ??
      this.getClaimsOwnershipError(resolvedPath);

    if (error) {
      return { error };
    }

    return withPathOperation(this.cwd, resolvedPath, () =>
      super.readRaw(resolvedPath),
    );
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
    const normalizedPath = normalizeVirtualPath(this.resolveWikiPath(filePath));
    const error =
      this.getIgnoredPathError(normalizedPath) ??
      this.getClaimsOwnershipError(normalizedPath) ??
      this.getDocsOnlyWriteError(normalizedPath, filePath);

    if (error) {
      return { error };
    }

    return withPathOperation(this.cwd, normalizedPath, async () =>
      markMutation(await super.write(normalizedPath, content), normalizedPath),
    );
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
    const normalizedPath = normalizeVirtualPath(this.resolveWikiPath(filePath));
    const error =
      this.getIgnoredPathError(normalizedPath) ??
      this.getClaimsOwnershipError(normalizedPath) ??
      this.getDocsOnlyWriteError(normalizedPath, filePath);

    if (error) {
      return { error };
    }

    return withPathOperation(this.cwd, normalizedPath, async () =>
      markMutation(
        await super.edit(normalizedPath, oldString, newString, replaceAll),
        normalizedPath,
      ),
    );
  }

  /**
   * Deletes a generated file while enforcing ignore, ownership, and docs-only rules.
   *
   * @param filePath - Virtual file path to delete.
   * @returns Backend deletion result with mutation metadata on success.
   */
  override async delete(filePath: string): Promise<DeleteResult> {
    const normalizedPath = normalizeVirtualPath(this.resolveWikiPath(filePath));
    const error =
      this.getIgnoredPathError(normalizedPath) ??
      this.getClaimsOwnershipError(normalizedPath) ??
      this.getDocsOnlyWriteError(normalizedPath, filePath);
    if (error) {
      return { error };
    }
    return withPathOperation(this.cwd, normalizedPath, async () =>
      markMutation(await super.delete(normalizedPath), normalizedPath),
    );
  }

  /**
   * List a directory, denying if the directory itself is excluded and otherwise
   * filtering out any ignored entries so they never surface to the agent.
   */
  override async ls(dirPath: string): Promise<LsResult> {
    const resolvedPath = this.resolveWikiPath(dirPath);
    const error =
      this.getIgnoredPathError(resolvedPath, true) ??
      this.getClaimsOwnershipError(resolvedPath);

    if (error) {
      return { error };
    }

    const result = await super.ls(resolvedPath);

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
    const resolvedDirectory = dirPath
      ? this.resolveWikiPath(dirPath)
      : undefined;
    if (
      resolvedDirectory &&
      (this.openWikiIgnore.ignores(resolvedDirectory, true) ||
        this.isClaimsPath(resolvedDirectory))
    ) {
      return { matches: [] };
    }

    const result = await super.grep(pattern, resolvedDirectory, glob);

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
    const resolvedSearchPath = searchPath
      ? this.resolveWikiPath(searchPath)
      : undefined;
    if (isBroadRootGlob(pattern, resolvedSearchPath)) {
      return {
        error:
          "Unbounded root globbing is disabled. Use ls at the repository root, then targeted glob or grep calls by directory and extension.",
      };
    }

    if (targetsGitMetadata(pattern, resolvedSearchPath)) {
      return {
        error:
          "Git metadata is private repository state and is unavailable to glob. Use `git rev-parse HEAD` when the current commit is needed.",
      };
    }

    if (resolvedSearchPath && this.isClaimsPath(resolvedSearchPath)) {
      return { files: [] };
    }

    if (
      resolvedSearchPath &&
      this.openWikiIgnore.ignores(resolvedSearchPath, true)
    ) {
      return { files: [] };
    }

    let result: GlobResult;

    try {
      result = await super.glob(pattern, resolvedSearchPath);
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
          !this.isClaimsDiscoveryPath(file.path, resolvedSearchPath),
      ),
    };
  }

  /**
   * Upload files, returning `permission_denied` for any path that is excluded by
   * `.openwikiignore` or (in docs-only mode) falls outside the active wiki tree,
   * while still uploading the allowed ones. As a write path, this enforces the
   * same docs-only confinement as {@link write}/{@link edit}. Results are
   * returned in the original input order.
   */
  override async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const resolvedFiles = files.map(([requestedPath, content]) => ({
      content,
      requestedPath,
      resolvedPath: this.resolveWikiPath(requestedPath),
    }));
    const allowedFiles = resolvedFiles.filter(
      ({ requestedPath, resolvedPath }) =>
        !this.isWriteBlocked(resolvedPath, requestedPath),
    );
    const allowedResults = await super.uploadFiles(
      allowedFiles.map(({ content, resolvedPath }) => [resolvedPath, content]),
    );
    let allowedResultIndex = 0;

    return resolvedFiles.map(({ requestedPath, resolvedPath }) => {
      if (this.isWriteBlocked(resolvedPath, requestedPath)) {
        return { error: "permission_denied", path: requestedPath };
      }

      const result = allowedResults[allowedResultIndex++];
      return result
        ? { ...result, path: requestedPath }
        : { error: "invalid_path", path: requestedPath };
    });
  }

  /**
   * Download files, returning `permission_denied` for any ignored path while
   * still downloading the allowed ones. Results preserve the input order.
   */
  override async downloadFiles(
    paths: string[],
  ): Promise<FileDownloadResponse[]> {
    const resolvedPaths = paths.map((requestedPath) => ({
      requestedPath,
      resolvedPath: this.resolveWikiPath(requestedPath),
    }));
    const allowedPaths = resolvedPaths.filter(
      ({ resolvedPath }) =>
        !this.openWikiIgnore.ignores(resolvedPath) &&
        !this.isClaimsPath(resolvedPath),
    );
    const allowedResults = await super.downloadFiles(
      allowedPaths.map(({ resolvedPath }) => resolvedPath),
    );
    let allowedResultIndex = 0;

    return resolvedPaths.map(({ requestedPath, resolvedPath }) => {
      if (
        this.openWikiIgnore.ignores(resolvedPath) ||
        this.isClaimsPath(resolvedPath)
      ) {
        return {
          content: null,
          error: "permission_denied",
          path: requestedPath,
        };
      }

      const result = allowedResults[allowedResultIndex++];
      return result
        ? { ...result, path: requestedPath }
        : {
            content: null,
            error: "invalid_path",
            path: requestedPath,
          };
    });
  }

  /**
   * Refuse shell execution in personal mode. Repository runs allow only narrow
   * maintenance commands because the underlying backend executes on the host.
   */
  override async execute(command: string): Promise<ExecuteResponse> {
    // Personal agents consume untrusted connector content, including during
    // unattended ingestion. Enforce this at the backend as well as the tool
    // surface so delegated or stale tool calls cannot reach the host shell.
    if (this.outputMode === "local-wiki") {
      return {
        exitCode: 1,
        output:
          "Shell execution is disabled in personal mode. Use wiki filesystem tools and openwiki_read_raw_item for connector evidence.",
        truncated: false,
      };
    }

    if (this.outputMode === "repository" && referencesClaimsState(command)) {
      return {
        exitCode: 1,
        output:
          "OpenWiki Claims state is implementation-owned and unavailable to shell execute.",
        truncated: false,
      };
    }

    if (!isAllowedShellCommand(command)) {
      return {
        exitCode: 1,
        output: `Shell execute is restricted because it cannot be confined to the OpenWiki workspace. Use the file tools instead (read_file, ls, glob, grep).${this.openWikiIgnore.isActive ? ` ${OPENWIKI_IGNORE_FILE} rules also remain enforced there.` : ""}`,
        truncated: false,
      };
    }

    return super.execute(command);
  }

  /**
   * Return a refusal message when a write escapes the docs tree in docs-only
   * mode, or `null` if the write is allowed. Always allows in `local-wiki` mode
   * or when the path is under the configured wiki directory.
   */
  private getDocsOnlyWriteError(
    filePath: string,
    requestedPath = filePath,
  ): string | null {
    if (!this.docsOnly || this.outputMode === "local-wiki") {
      return null;
    }

    if (!isOpenWikiDocsPath(filePath, this.wikiDirectory)) {
      return `OpenWiki repository init/update runs may only write under /${this.wikiDirectory}/. Refused path: ${requestedPath}`;
    }

    if (
      this.writableWikiPages !== undefined &&
      !this.writableWikiPages.has(normalizeVirtualPath(filePath))
    ) {
      return `This OpenWiki worker may not modify ${filePath}.`;
    }

    return null;
  }

  /**
   * Maps the stable code-owned virtual namespace to the active physical wiki.
   */
  private resolveWikiPath(filePath: string): string {
    return mapVirtualWikiPath(filePath, this.wikiDirectory);
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
    return (
      this.outputMode === "repository" &&
      isClaimsStatePath(filePath, this.wikiDirectory)
    );
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
  private isWriteBlocked(filePath: string, requestedPath = filePath): boolean {
    return (
      this.openWikiIgnore.ignores(filePath) ||
      this.isClaimsPath(filePath) ||
      this.getDocsOnlyWriteError(filePath, requestedPath) !== null
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
export function isClaimsStatePath(
  filePath: string,
  wikiDirectory = OPEN_WIKI_VIRTUAL_DIR,
): boolean {
  const normalized = path.posix
    .normalize(filePath.replaceAll("\\", "/"))
    .toLowerCase();
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;

  const claimsRoot = `/${normalizeRepositoryWikiDirectory(wikiDirectory).toLowerCase()}/.claims`;
  return absolute === claimsRoot || absolute.startsWith(`${claimsRoot}/`);
}

/**
 * Whether a path resolves to somewhere inside the configured wiki docs tree.
 *
 * The path is canonicalized (backslashes, leading slashes, and `.`/`..`
 * segments collapsed) before the prefix check so a path such as
 * `/openwiki/../AGENTS.md` cannot escape the confinement.
 */
export function isOpenWikiDocsPath(
  filePath: string,
  wikiDirectory = OPEN_WIKI_VIRTUAL_DIR,
): boolean {
  const slashed = filePath.trim().replace(/\\/gu, "/");
  // Collapse `..`/`.` segments before the prefix check so a path like
  // "/openwiki/../AGENTS.md" cannot escape the wiki confinement.
  const normalized = path.posix.normalize(`/${slashed.replace(/^\/+/u, "")}`);
  const virtualPath = normalized.replace(/^\/+/u, "");

  const directory = normalizeRepositoryWikiDirectory(wikiDirectory);
  return virtualPath === directory || virtualPath.startsWith(`${directory}/`);
}

/**
 * Maps the stable persisted page namespace to the active physical directory.
 */
function mapVirtualWikiPath(filePath: string, wikiDirectory: string): string {
  const normalized = normalizeVirtualPath(filePath);
  const virtualRoot = `/${OPEN_WIKI_VIRTUAL_DIR}`;
  if (normalized === virtualRoot) return `/${wikiDirectory}`;
  if (normalized.startsWith(`${virtualRoot}/`)) {
    return `/${wikiDirectory}/${normalized.slice(virtualRoot.length + 1)}`;
  }
  return filePath;
}

/**
 * Converts a model-facing path into one canonical absolute virtual path.
 *
 * @param filePath - Relative, absolute, or backslash-separated virtual path.
 * @returns Canonical absolute POSIX virtual path.
 */
function normalizeVirtualPath(filePath: string): string {
  const slashed = filePath.trim().replaceAll("\\", "/");
  return path.posix.normalize(`/${slashed.replace(/^\/+/, "")}`);
}

/**
 * Whether a shell command is on the {@link allowedShellCommands} allowlist.
 */
function isAllowedShellCommand(command: string): boolean {
  const trimmedCommand = command.trim();

  return allowedShellCommands.some((allowedCommand) =>
    allowedCommand.test(trimmedCommand),
  );
}
