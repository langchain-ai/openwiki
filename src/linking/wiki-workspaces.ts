import {
  constants as fsConstants,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UPDATE_METADATA_PATH } from "../config/constants.js";
import { resolveOpenWikiHomeDir } from "../config/openwiki-home.js";
import { writeTextAtomic } from "../integrations/install/atomic-file.js";
import { restrictDirToCurrentUser } from "../platform/windows-acl.js";

/**
 * File containing the user's named wiki workspaces.
 */
export const WIKI_WORKSPACES_FILE = "wiki-workspaces.json";

/**
 * Current on-disk schema version for wiki workspaces.
 */
const WIKI_WORKSPACES_VERSION = 1;

/**
 * Maximum directory depth inspected by automatic wiki discovery.
 */
const MAX_DISCOVERY_DEPTH = 8;

/**
 * Maximum supported serialized registry size.
 */
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;

/**
 * Maximum number of registered repository wikis.
 */
const MAX_REGISTERED_WIKIS = 10_000;

/**
 * Maximum number of named wiki workspaces.
 */
const MAX_REGISTERED_WORKSPACES = 1_000;

/**
 * Directory names that cannot contain a separately linked repository wiki.
 */
const IGNORED_DISCOVERY_DIRECTORIES = new Set([".git", "node_modules"]);

/**
 * Filesystem outcomes expected while directories change during discovery.
 */
const EXPECTED_DISCOVERY_ERROR_CODES = new Set([
  "EACCES",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
]);

/**
 * Stable identifier accepted by workspace and retrieval operations.
 */
const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

/**
 * One Git repository shown by the interactive repository finder.
 */
export interface DiscoveredRepository {
  /**
   * Canonical absolute repository root.
   */
  root: string;

  /**
   * Human-readable repository name.
   */
  name: string;

  /**
   * Display path relative to the directory being inspected when possible.
   */
  path: string;

  /**
   * Whether the repository contains OpenWiki run metadata and can be linked.
   */
  hasOpenWiki: boolean;
}

/**
 * One repository wiki stored in the global registry.
 */
export interface RegisteredWiki {
  /**
   * Stable identity accepted by retrieval tools.
   */
  id: string;

  /**
   * Human-readable repository name.
   */
  name: string;

  /**
   * Canonical absolute repository root.
   */
  root: string;
}

/**
 * One named exact union of repository wikis.
 */
export interface WikiWorkspace {
  /**
   * Stable workspace identity accepted by tools and the CLI.
   */
  id: string;

  /**
   * Human-readable globally unique workspace name.
   */
  name: string;

  /**
   * Stable IDs of the wikis included in this workspace.
   */
  wikis: string[];
}

/**
 * One repository's persistent active-workspace selection.
 */
export interface ActiveWikiWorkspace {
  /**
   * Repository wiki receiving the default selection.
   */
  wiki: string;

  /**
   * Workspace used when search does not provide an explicit workspace.
   */
  workspace: string;
}

/**
 * Strict versioned registry persisted under the OpenWiki home directory.
 */
export interface WikiWorkspaceRegistry {
  /**
   * Exact persisted schema version.
   */
  version: 1;

  /**
   * Normalized repository wiki inventory.
   */
  wikis: RegisteredWiki[];

  /**
   * Named many-to-many wiki memberships.
   */
  workspaces: WikiWorkspace[];

  /**
   * Optional persistent selection for repositories with overlapping workspaces.
   */
  active: ActiveWikiWorkspace[];
}

/**
 * Editable workspace representation used by the interactive manager.
 */
export interface WikiWorkspaceDraft {
  /**
   * Existing stable identity, omitted for a new workspace.
   */
  id?: string;

  /**
   * Human-readable workspace name.
   */
  name: string;

  /**
   * Exact canonical repository roots selected for the workspace.
   */
  roots: string[];
}

/**
 * Optional storage override used to isolate tests and embedded callers.
 */
export interface WikiWorkspaceStorageOptions {
  /**
   * OpenWiki home directory containing the workspace registry.
   */
  configDirectory?: string;
}

/**
 * Compact workspace identity returned by listing and ambiguity responses.
 */
export interface WikiWorkspaceSummary {
  /**
   * Stable workspace identity.
   */
  id: string;

  /**
   * Human-readable workspace name.
   */
  name: string;

  /**
   * Number of repository wikis in the workspace.
   */
  wikiCount: number;
}

/**
 * Wiki identity exposed to retrieval clients.
 */
export interface WikiIdentity {
  /**
   * Stable wiki identity.
   */
  id: string;

  /**
   * Human-readable repository name.
   */
  name: string;
}

/**
 * Workspaces containing one requested wiki.
 */
export interface WikiWorkspaceList {
  /**
   * Wiki whose memberships were inspected.
   */
  wiki: WikiIdentity;

  /**
   * Persistent active workspace when one is configured for the wiki.
   */
  activeWorkspace?: string;

  /**
   * Deterministically ordered containing workspaces.
   */
  workspaces: WikiWorkspaceSummary[];
}

/**
 * Member wikis returned for one workspace.
 */
export interface WorkspaceWikiList {
  /**
   * Selected workspace identity.
   */
  workspace: WikiWorkspaceSummary;

  /**
   * Deterministically ordered workspace members.
   */
  wikis: WikiIdentity[];
}

/**
 * One validated repository wiki ready for retrieval.
 */
export interface ResolvedWiki extends WikiIdentity {
  /**
   * Canonical absolute repository root.
   */
  root: string;
}

/**
 * Search scope resolved to the current wiki or one workspace.
 */
export interface ResolvedWikiSearchScope {
  /**
   * Successful resolution discriminator.
   */
  status: "ready";

  /**
   * Wiki from which the search began.
   */
  current: WikiIdentity;

  /**
   * Selected workspace, omitted for a standalone wiki.
   */
  workspace?: WikiWorkspaceSummary;

  /**
   * Validated wikis included in the exact search scope.
   */
  wikis: ResolvedWiki[];
}

/**
 * Search resolution result requiring a conversational workspace choice.
 */
export interface WikiWorkspaceRequired {
  /**
   * Ambiguous resolution discriminator.
   */
  status: "workspace_required";

  /**
   * Wiki from which the search began.
   */
  wiki: WikiIdentity;

  /**
   * Workspaces the agent can present to the user.
   */
  workspaces: WikiWorkspaceSummary[];
}

/**
 * Complete result of applying automatic workspace-selection rules.
 */
export type WikiSearchScope = ResolvedWikiSearchScope | WikiWorkspaceRequired;

/**
 * One directory pending bounded recursive discovery.
 */
interface DiscoveryDirectory {
  /**
   * Canonical absolute directory to inspect.
   */
  directory: string;

  /**
   * Descendant depth relative to the discovery root.
   */
  depth: number;
}

/**
 * Expected workspace configuration or discovery failure.
 */
export class WikiWorkspaceError extends Error {
  /**
   * Creates a caller-safe workspace error.
   *
   * @param message - Stable correction guidance safe for CLI and MCP clients.
   */
  constructor(message: string) {
    super(message);
    this.name = "WikiWorkspaceError";
  }
}

/**
 * Creates the empty supported workspace registry.
 *
 * @returns Empty versioned registry.
 */
export function emptyWikiWorkspaceRegistry(): WikiWorkspaceRegistry {
  return {
    version: WIKI_WORKSPACES_VERSION,
    wikis: [],
    workspaces: [],
    active: [],
  };
}

/**
 * Resolves the canonical directory used as the interactive finder root.
 *
 * @param location - User-entered absolute, relative, or home-relative path.
 * @param baseDirectory - Directory used to resolve a relative location.
 * @returns Canonical absolute finder root.
 */
export async function resolveRepositoryFinderRoot(
  location: string,
  baseDirectory: string = process.cwd(),
): Promise<string> {
  return canonicalDirectory(resolveUserPath(location, baseDirectory));
}

/**
 * Streams repositories from the nearest existing directory for an editable path.
 *
 * A partial path such as `~/de` searches from its existing parent so the caller
 * can filter streamed repository paths while the user continues typing.
 *
 * @param location - Complete or partial user-entered finder path.
 * @param baseDirectory - Directory used to resolve a relative location.
 * @param signal - Optional cancellation signal forwarded to discovery.
 * @returns Repositories below the nearest existing directory.
 */
export async function* discoverRepositoriesFromPath(
  location: string,
  baseDirectory: string = process.cwd(),
  signal?: AbortSignal,
): AsyncGenerator<DiscoveredRepository> {
  const requested = resolveUserPath(location, baseDirectory);
  const discoveryRoot = await nearestExistingDirectory(requested);
  yield* discoverRepositories(discoveryRoot, signal);
}

/**
 * Streams Git repositories below one directory for interactive filtering.
 *
 * Discovery never follows symbolic links, stops at each Git repository
 * boundary, and bounds traversal depth without rejecting large code roots.
 *
 * @param startDirectory - Directory whose descendants should be inspected.
 * @param signal - Optional cancellation signal checked between filesystem reads.
 * @returns Repositories in deterministic path order as they are found.
 * @throws {WikiWorkspaceError} When the starting directory is invalid.
 */
export async function* discoverRepositories(
  startDirectory: string,
  signal?: AbortSignal,
): AsyncGenerator<DiscoveredRepository> {
  const discoveryRoot = await canonicalDirectory(startDirectory);
  const pending: DiscoveryDirectory[] = [
    { directory: discoveryRoot, depth: 0 },
  ];

  while (pending.length > 0) {
    if (signal?.aborted) return;
    const current = pending.pop();
    if (!current) break;

    if (await isGitRepository(current.directory)) {
      yield await discoveredRepository(discoveryRoot, current.directory);
      continue;
    }

    if (current.depth >= MAX_DISCOVERY_DEPTH) continue;
    const entries = await readDiscoveryDirectory(current.directory);
    if (signal?.aborted) return;
    for (const entry of [...entries]
      .sort((left, right) => left.name.localeCompare(right.name))
      .reverse()) {
      if (!isDiscoverableDirectory(entry)) continue;
      pending.push({
        directory: path.join(current.directory, entry.name),
        depth: current.depth + 1,
      });
    }
  }
}

/**
 * Reads and strictly validates the user's global workspace registry.
 *
 * @param options - Optional OpenWiki home override.
 * @returns Parsed registry or an empty registry when none exists.
 */
export async function readWikiWorkspaceRegistry(
  options: WikiWorkspaceStorageOptions = {},
): Promise<WikiWorkspaceRegistry> {
  const registryPath = workspaceRegistryPath(options);
  let content: string | null;
  try {
    content = await readWorkspaceRegistryFile(registryPath);
  } catch (error) {
    if (error instanceof WikiWorkspaceError) throw error;
    throw invalidRegistryError();
  }
  if (content === null) return emptyWikiWorkspaceRegistry();

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw invalidRegistryError();
  }
  if (!isWikiWorkspaceRegistry(parsed)) throw invalidRegistryError();
  return parsed;
}

/**
 * Reads the workspace registry through the same descriptor that is validated.
 *
 * @param registryPath - Absolute workspace registry path.
 * @returns Registry text, or `null` when no registry exists.
 */
async function readWorkspaceRegistryFile(
  registryPath: string,
): Promise<string | null> {
  let fileHandle: Awaited<ReturnType<typeof open>>;
  try {
    fileHandle = await open(registryPath, workspaceRegistryOpenFlags());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  try {
    const openedStats = await fileHandle.stat({ bigint: true });
    if (
      !openedStats.isFile() ||
      openedStats.size > BigInt(MAX_REGISTRY_BYTES)
    ) {
      throw invalidRegistryError();
    }
    // Attest the pathname after acquiring the descriptor. A later path swap
    // cannot redirect the descriptor-backed read below.
    const pathStats = await lstat(registryPath, { bigint: true });
    if (!isSameWorkspaceRegistryFile(pathStats, openedStats)) {
      throw invalidRegistryError();
    }
    const content = await fileHandle.readFile("utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_REGISTRY_BYTES) {
      throw invalidRegistryError();
    }
    return content;
  } finally {
    await fileHandle.close();
  }
}

/**
 * Verifies that an opened registry is still represented by its regular path.
 *
 * @param inspectedStats - Non-following path metadata captured after opening.
 * @param openedStats - Metadata captured from the opened descriptor.
 * @returns Whether both observations identify the same regular file.
 */
function isSameWorkspaceRegistryFile(
  inspectedStats: BigIntStats,
  openedStats: BigIntStats,
): boolean {
  if (!inspectedStats.isFile() || !openedStats.isFile()) return false;
  if (process.platform !== "win32") {
    return (
      inspectedStats.dev === openedStats.dev &&
      inspectedStats.ino === openedStats.ino
    );
  }
  return (
    inspectedStats.size === openedStats.size &&
    inspectedStats.mtimeNs === openedStats.mtimeNs &&
    inspectedStats.birthtimeNs === openedStats.birthtimeNs
  );
}

/**
 * Builds read-only flags that reject a final symlink when supported.
 *
 * @returns Numeric flags for opening the workspace registry.
 */
function workspaceRegistryOpenFlags(): number {
  return (
    fsConstants.O_RDONLY |
    (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0)
  );
}

/**
 * Atomically replaces the complete named workspace collection.
 *
 * Stable workspace and wiki IDs are retained whenever their logical object
 * remains present. Active selections invalidated by an edit are removed.
 *
 * @param drafts - Complete final workspace collection from the manager.
 * @param options - Optional OpenWiki home override.
 * @returns Persisted normalized registry.
 */
export async function saveWikiWorkspaces(
  drafts: readonly WikiWorkspaceDraft[],
  options: WikiWorkspaceStorageOptions = {},
): Promise<WikiWorkspaceRegistry> {
  if (drafts.length > MAX_REGISTERED_WORKSPACES) {
    throw new WikiWorkspaceError("Too many wiki workspaces are configured.");
  }
  const previous = await readWikiWorkspaceRegistry(options);
  validateDraftNames(drafts);
  const canonicalDrafts = await Promise.all(
    drafts.map(async (draft) => ({
      ...draft,
      roots: await canonicalWikiRoots(draft.roots),
    })),
  );
  const roots = [
    ...new Set(canonicalDrafts.flatMap((draft) => draft.roots)),
  ].sort((left, right) => left.localeCompare(right));
  if (roots.length > MAX_REGISTERED_WIKIS) {
    throw new WikiWorkspaceError("Too many repository wikis are configured.");
  }

  const wikis = assignRegisteredWikis(roots, previous.wikis);
  const wikiIdByRoot = new Map(wikis.map((wiki) => [wiki.root, wiki.id]));
  const workspaces = assignWorkspaces(
    canonicalDrafts,
    wikiIdByRoot,
    previous.workspaces,
  );
  const membershipByWorkspace = new Map(
    workspaces.map((workspace) => [workspace.id, new Set(workspace.wikis)]),
  );
  const wikiIds = new Set(wikis.map((wiki) => wiki.id));
  const active = previous.active
    .filter(
      (selection) =>
        wikiIds.has(selection.wiki) &&
        membershipByWorkspace.get(selection.workspace)?.has(selection.wiki),
    )
    .sort((left, right) => left.wiki.localeCompare(right.wiki));
  const registry: WikiWorkspaceRegistry = {
    version: WIKI_WORKSPACES_VERSION,
    wikis,
    workspaces,
    active,
  };
  await writeWorkspaceRegistry(registry, options);
  return registry;
}

/**
 * Lists the workspaces containing the current or explicitly addressed wiki.
 *
 * @param repositoryRoot - Repository from which the tool call originates.
 * @param wikiId - Optional known wiki ID; omitted for the current repository.
 * @param options - Optional OpenWiki home override.
 * @returns Target wiki, its active selection, and containing workspaces.
 */
export async function listWikiWorkspaces(
  repositoryRoot: string,
  wikiId?: string,
  options: WikiWorkspaceStorageOptions = {},
): Promise<WikiWorkspaceList> {
  const context = await loadRepositoryContext(repositoryRoot, options);
  const wiki = wikiId ? findReachableWiki(context, wikiId) : context.current;
  const workspaces = context.isRegistered
    ? containingWorkspaces(context.registry, wiki.id)
    : [];
  const activeWorkspace = context.isRegistered
    ? context.registry.active.find((selection) => selection.wiki === wiki.id)
        ?.workspace
    : undefined;
  return {
    wiki: wikiIdentity(wiki),
    ...(activeWorkspace ? { activeWorkspace } : {}),
    workspaces: workspaces.map(workspaceSummary),
  };
}

/**
 * Lists every wiki in one workspace containing the current repository.
 *
 * @param repositoryRoot - Repository from which the tool call originates.
 * @param workspaceReference - Workspace ID or unique case-insensitive name.
 * @param options - Optional OpenWiki home override.
 * @returns Selected workspace and its member wiki identities.
 */
export async function listWorkspaceWikis(
  repositoryRoot: string,
  workspaceReference: string,
  options: WikiWorkspaceStorageOptions = {},
): Promise<WorkspaceWikiList> {
  const context = await loadRepositoryContext(repositoryRoot, options);
  const workspace = resolveContainingWorkspace(context, workspaceReference);
  return {
    workspace: workspaceSummary(workspace),
    wikis: workspace.wikis.map((id) =>
      wikiIdentity(requireRegisteredWiki(context.registry, id)),
    ),
  };
}

/**
 * Applies explicit, active, and implicit workspace selection for search.
 *
 * @param repositoryRoot - Repository from which search begins.
 * @param requestedWorkspace - Optional explicit workspace ID or name.
 * @param options - Optional OpenWiki home override.
 * @returns A ready exact scope or structured ambiguity choices.
 */
export async function resolveWikiSearchScope(
  repositoryRoot: string,
  requestedWorkspace?: string,
  options: WikiWorkspaceStorageOptions = {},
): Promise<WikiSearchScope> {
  const context = await loadRepositoryContext(repositoryRoot, options);
  if (!context.isRegistered) {
    if (requestedWorkspace) requireRegisteredRepository(context);
    return {
      status: "ready",
      current: wikiIdentity(context.current),
      wikis: [{ ...wikiIdentity(context.current), root: context.current.root }],
    };
  }
  const containing = containingWorkspaces(context.registry, context.current.id);
  if (requestedWorkspace) {
    return materializeSearchScope(
      context.registry,
      context.current,
      resolveContainingWorkspace(context, requestedWorkspace),
    );
  }
  if (containing.length === 0) {
    return {
      status: "ready",
      current: wikiIdentity(context.current),
      wikis: [{ ...wikiIdentity(context.current), root: context.current.root }],
    };
  }
  if (containing.length === 1) {
    return materializeSearchScope(
      context.registry,
      context.current,
      containing[0],
    );
  }

  const activeWorkspaceId = context.registry.active.find(
    (selection) => selection.wiki === context.current.id,
  )?.workspace;
  const activeWorkspace = containing.find(
    (workspace) => workspace.id === activeWorkspaceId,
  );
  if (activeWorkspace) {
    return materializeSearchScope(
      context.registry,
      context.current,
      activeWorkspace,
    );
  }
  return {
    status: "workspace_required",
    wiki: wikiIdentity(context.current),
    workspaces: containing.map(workspaceSummary),
  };
}

/**
 * Resolves one exact wiki that the current repository is allowed to read.
 *
 * @param repositoryRoot - Repository from which the read originates.
 * @param wikiId - Optional target wiki ID; omitted for the current repository.
 * @param options - Optional OpenWiki home override.
 * @returns Validated target repository wiki.
 */
export async function resolveReadableWiki(
  repositoryRoot: string,
  wikiId?: string,
  options: WikiWorkspaceStorageOptions = {},
): Promise<ResolvedWiki> {
  const context = await loadRepositoryContext(repositoryRoot, options);
  if (!context.isRegistered) {
    if (wikiId) requireRegisteredRepository(context);
    return { ...wikiIdentity(context.current), root: context.current.root };
  }
  if (!wikiId || wikiId === context.current.id) {
    return { ...wikiIdentity(context.current), root: context.current.root };
  }
  return materializeWiki(findReachableWiki(context, wikiId));
}

/**
 * Sets the active workspace for one repository wiki.
 *
 * @param repositoryRoot - Current repository root or nested directory.
 * @param workspaceReference - Containing workspace ID or unique name.
 * @param options - Optional OpenWiki home override.
 * @returns Newly active workspace summary.
 */
export async function setActiveWikiWorkspace(
  repositoryRoot: string,
  workspaceReference: string,
  options: WikiWorkspaceStorageOptions = {},
): Promise<WikiWorkspaceSummary> {
  const context = await loadRepositoryContext(repositoryRoot, options);
  const workspace = resolveContainingWorkspace(context, workspaceReference);
  const active = context.registry.active.filter(
    (selection) => selection.wiki !== context.current.id,
  );
  active.push({ wiki: context.current.id, workspace: workspace.id });
  active.sort((left, right) => left.wiki.localeCompare(right.wiki));
  await writeWorkspaceRegistry({ ...context.registry, active }, options);
  return workspaceSummary(workspace);
}

/**
 * Clears the active workspace for one repository wiki.
 *
 * @param repositoryRoot - Current repository root or nested directory.
 * @param options - Optional OpenWiki home override.
 * @returns Whether a persistent selection was removed.
 */
export async function clearActiveWikiWorkspace(
  repositoryRoot: string,
  options: WikiWorkspaceStorageOptions = {},
): Promise<boolean> {
  const context = await loadRepositoryContext(repositoryRoot, options);
  requireRegisteredRepository(context);
  const active = context.registry.active.filter(
    (selection) => selection.wiki !== context.current.id,
  );
  if (active.length === context.registry.active.length) return false;
  await writeWorkspaceRegistry({ ...context.registry, active }, options);
  return true;
}

/**
 * Converts the persisted registry into editable manager drafts.
 *
 * @param registry - Strict workspace registry.
 * @returns Workspaces containing canonical repository roots.
 */
export function workspaceDrafts(
  registry: WikiWorkspaceRegistry,
): WikiWorkspaceDraft[] {
  const wikiById = new Map(registry.wikis.map((wiki) => [wiki.id, wiki]));
  return registry.workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    roots: workspace.wikis.map((id) => {
      const wiki = wikiById.get(id);
      if (!wiki) throw invalidRegistryError();
      return wiki.root;
    }),
  }));
}

/**
 * Repository and registry context shared by workspace operations.
 */
interface RepositoryContext {
  /**
   * Strict global registry.
   */
  registry: WikiWorkspaceRegistry;

  /**
   * Current repository wiki, registered or local-only.
   */
  current: RegisteredWiki;

  /**
   * Whether current was identified by an exact canonical-root registry match.
   */
  isRegistered: boolean;
}

/**
 * Loads the registry and identifies the canonical current repository.
 *
 * @param repositoryRoot - Repository root or nested directory.
 * @param options - Optional OpenWiki home override.
 * @returns Shared operation context.
 */
async function loadRepositoryContext(
  repositoryRoot: string,
  options: WikiWorkspaceStorageOptions,
): Promise<RepositoryContext> {
  const root = await canonicalDirectory(repositoryRoot);
  const registry = await readWikiWorkspaceRegistry(options);
  const registered = registry.wikis.find((wiki) => wiki.root === root);
  const current = registered ?? localWiki(root);
  return { registry, current, isRegistered: registered !== undefined };
}

/**
 * Rejects workspace operations whose repository identity is only local.
 *
 * Local fallback IDs are display conveniences and must never authorize access
 * to registered wikis or mutate registered workspace state.
 *
 * @param context - Current repository and registry context.
 */
function requireRegisteredRepository(context: RepositoryContext): void {
  if (context.isRegistered) return;
  throw new WikiWorkspaceError(
    "The current repository is not registered in a wiki workspace. Link it before accessing or changing workspace wikis.",
  );
}

/**
 * Resolves one requested wiki while keeping traversal within shared workspaces.
 *
 * @param context - Current registered repository and strict global registry.
 * @param wikiId - Requested stable wiki ID.
 * @returns Reachable registered wiki.
 */
function findReachableWiki(
  context: RepositoryContext,
  wikiId: string,
): RegisteredWiki {
  requireRegisteredRepository(context);
  const { registry, current } = context;
  if (wikiId === current.id) return current;
  const target = registry.wikis.find((wiki) => wiki.id === wikiId);
  if (!target) {
    throw new WikiWorkspaceError(
      "Unknown wiki ID. Use an ID returned by OpenWiki search or listing.",
    );
  }
  const shared = registry.workspaces.some(
    (workspace) =>
      workspace.wikis.includes(current.id) &&
      workspace.wikis.includes(target.id),
  );
  if (!shared) {
    throw new WikiWorkspaceError(
      "The requested wiki does not share a workspace with the current repository.",
    );
  }
  return target;
}

/**
 * Resolves a workspace reference and verifies current-wiki membership.
 *
 * @param context - Current registered repository and strict global registry.
 * @param reference - Stable ID or case-insensitive workspace name.
 * @returns Matching containing workspace.
 */
function resolveContainingWorkspace(
  context: RepositoryContext,
  reference: string,
): WikiWorkspace {
  requireRegisteredRepository(context);
  const { registry, current } = context;
  const normalized = reference.trim().toLowerCase();
  const workspace = registry.workspaces.find(
    (candidate) =>
      candidate.id === normalized ||
      candidate.name.toLowerCase() === normalized,
  );
  if (!workspace || !workspace.wikis.includes(current.id)) {
    throw new WikiWorkspaceError(
      "Unknown workspace for this repository. Use openwiki_list_workspaces to choose one.",
    );
  }
  return workspace;
}

/**
 * Returns every workspace containing one wiki in deterministic order.
 *
 * @param registry - Strict global registry.
 * @param wikiId - Stable wiki identity.
 * @returns Containing workspaces sorted by name and ID.
 */
function containingWorkspaces(
  registry: WikiWorkspaceRegistry,
  wikiId: string,
): WikiWorkspace[] {
  return registry.workspaces
    .filter((workspace) => workspace.wikis.includes(wikiId))
    .sort(compareWorkspaces);
}

/**
 * Materializes every member of one selected search workspace.
 *
 * @param registry - Strict global registry.
 * @param current - Current repository wiki.
 * @param workspace - Selected containing workspace.
 * @returns Ready exact search scope.
 */
async function materializeSearchScope(
  registry: WikiWorkspaceRegistry,
  current: RegisteredWiki,
  workspace: WikiWorkspace,
): Promise<ResolvedWikiSearchScope> {
  const wikis = await Promise.all(
    workspace.wikis.map((id) =>
      materializeWiki(requireRegisteredWiki(registry, id)),
    ),
  );
  return {
    status: "ready",
    current: wikiIdentity(current),
    workspace: workspaceSummary(workspace),
    wikis,
  };
}

/**
 * Validates one persisted repository path immediately before retrieval.
 *
 * @param wiki - Persisted wiki entry.
 * @returns Wiki with a verified canonical repository root.
 */
async function materializeWiki(wiki: RegisteredWiki): Promise<ResolvedWiki> {
  let canonical: string;
  try {
    canonical = await realpath(wiki.root);
  } catch {
    throw staleWorkspaceError();
  }
  if (canonical !== wiki.root || !(await isWikiRepository(canonical))) {
    throw staleWorkspaceError();
  }
  return { ...wikiIdentity(wiki), root: canonical };
}

/**
 * Finds one registered wiki by stable identity.
 *
 * @param registry - Strict global registry.
 * @param wikiId - Referenced wiki identity.
 * @returns Matching registered wiki.
 */
function requireRegisteredWiki(
  registry: WikiWorkspaceRegistry,
  wikiId: string,
): RegisteredWiki {
  const wiki = registry.wikis.find((candidate) => candidate.id === wikiId);
  if (!wiki) throw invalidRegistryError();
  return wiki;
}

/**
 * Creates a client-facing wiki identity without exposing its local path.
 *
 * @param wiki - Registered or local wiki.
 * @returns Stable ID and display name.
 */
function wikiIdentity(wiki: RegisteredWiki): WikiIdentity {
  return { id: wiki.id, name: wiki.name };
}

/**
 * Creates a compact workspace description.
 *
 * @param workspace - Persisted workspace.
 * @returns Client-facing workspace identity and member count.
 */
function workspaceSummary(workspace: WikiWorkspace): WikiWorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    wikiCount: workspace.wikis.length,
  };
}

/**
 * Assigns stable IDs to the final unique repository root collection.
 *
 * @param roots - Canonical selected repository roots.
 * @param previous - Prior registered wiki entries.
 * @returns Deterministically ordered normalized wiki entries.
 */
function assignRegisteredWikis(
  roots: readonly string[],
  previous: readonly RegisteredWiki[],
): RegisteredWiki[] {
  const previousByRoot = new Map(previous.map((wiki) => [wiki.root, wiki]));
  const retainedIds = new Set(
    roots
      .map((root) => previousByRoot.get(root)?.id)
      .filter((id): id is string => id !== undefined),
  );
  const used = new Set(retainedIds);
  return roots.map((root) => {
    const retained = previousByRoot.get(root);
    if (retained) return retained;
    const name = path.basename(root);
    const id = uniqueIdentifier(slugIdentifier(name, "wiki"), used);
    used.add(id);
    return { id, name, root };
  });
}

/**
 * Assigns stable workspace IDs and maps canonical roots to wiki IDs.
 *
 * @param drafts - Canonical validated workspace drafts.
 * @param wikiIdByRoot - Stable wiki identity lookup.
 * @param previous - Previous workspace collection.
 * @returns Deterministically ordered normalized workspaces.
 */
function assignWorkspaces(
  drafts: readonly WikiWorkspaceDraft[],
  wikiIdByRoot: ReadonlyMap<string, string>,
  previous: readonly WikiWorkspace[],
): WikiWorkspace[] {
  const previousIds = new Set(previous.map((workspace) => workspace.id));
  const retainedIds = drafts
    .map((draft) => draft.id)
    .filter((id): id is string => id !== undefined && previousIds.has(id));
  if (new Set(retainedIds).size !== retainedIds.length) {
    throw new WikiWorkspaceError("Duplicate wiki workspace identity.");
  }
  const used = new Set(retainedIds);
  const emittedRetained = new Set<string>();
  return drafts
    .map((draft) => {
      const retained = draft.id && previousIds.has(draft.id) ? draft.id : null;
      const id = retained
        ? retained
        : uniqueIdentifier(slugIdentifier(draft.name, "workspace"), used);
      if (retained && emittedRetained.has(id)) {
        throw new WikiWorkspaceError("Duplicate wiki workspace identity.");
      }
      used.add(id);
      if (retained) emittedRetained.add(retained);
      return {
        id,
        name: draft.name.trim(),
        wikis: draft.roots
          .map((root) => {
            const wikiId = wikiIdByRoot.get(root);
            if (!wikiId) throw invalidRegistryError();
            return wikiId;
          })
          .sort((left, right) => left.localeCompare(right)),
      };
    })
    .sort(compareWorkspaces);
}

/**
 * Canonicalizes, deduplicates, and verifies one workspace's selected roots.
 *
 * @param roots - User-selected repository roots.
 * @returns Deterministically ordered canonical roots.
 */
async function canonicalWikiRoots(roots: readonly string[]): Promise<string[]> {
  const canonical = [
    ...new Set(await Promise.all(roots.map(canonicalDirectory))),
  ].sort((left, right) => left.localeCompare(right));
  if (canonical.length < 2) {
    throw new WikiWorkspaceError(
      "Each wiki workspace must contain at least two repository wikis.",
    );
  }
  for (const root of canonical) {
    if (!(await isWikiRepository(root))) {
      throw new WikiWorkspaceError(
        `Every selected repository must contain ${UPDATE_METADATA_PATH}.`,
      );
    }
  }
  return canonical;
}

/**
 * Validates workspace names before filesystem work begins.
 *
 * @param drafts - Complete final workspace collection.
 */
function validateDraftNames(drafts: readonly WikiWorkspaceDraft[]): void {
  const names = new Set<string>();
  for (const draft of drafts) {
    const name = draft.name.trim();
    const normalized = name.toLowerCase();
    if (!isDisplayName(name) || names.has(normalized)) {
      throw new WikiWorkspaceError(
        "Workspace names must be unique, printable, and at most 80 characters.",
      );
    }
    names.add(normalized);
  }
}

/**
 * Atomically persists one already validated registry with private permissions.
 *
 * @param registry - Complete strict registry.
 * @param options - Optional OpenWiki home override.
 */
async function writeWorkspaceRegistry(
  registry: WikiWorkspaceRegistry,
  options: WikiWorkspaceStorageOptions,
): Promise<void> {
  if (!isWikiWorkspaceRegistry(registry)) throw invalidRegistryError();
  const registryPath = workspaceRegistryPath(options);
  const directory = path.dirname(registryPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await restrictDirToCurrentUser(directory);
  await writeTextAtomic(
    registryPath,
    `${JSON.stringify(registry, null, 2)}\n`,
    0o600,
  );
  await chmod(registryPath, 0o600);
}

/**
 * Resolves the private workspace-registry path.
 *
 * @param options - Optional OpenWiki home override.
 * @returns Absolute registry path.
 */
function workspaceRegistryPath(options: WikiWorkspaceStorageOptions): string {
  const directory = path.resolve(
    options.configDirectory ?? resolveOpenWikiHomeDir(),
  );
  return path.join(directory, WIKI_WORKSPACES_FILE);
}

/**
 * Strictly validates the complete persisted registry shape and references.
 *
 * @param value - Unknown parsed JSON value.
 * @returns Whether the value is a supported registry.
 */
function isWikiWorkspaceRegistry(
  value: unknown,
): value is WikiWorkspaceRegistry {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "wikis", "workspaces", "active"]) ||
    value.version !== WIKI_WORKSPACES_VERSION ||
    !Array.isArray(value.wikis) ||
    !Array.isArray(value.workspaces) ||
    !Array.isArray(value.active) ||
    value.wikis.length > MAX_REGISTERED_WIKIS ||
    value.workspaces.length > MAX_REGISTERED_WORKSPACES ||
    value.active.length > MAX_REGISTERED_WIKIS
  ) {
    return false;
  }

  const wikiIds = new Set<string>();
  const wikiRoots = new Set<string>();
  for (const wiki of value.wikis) {
    if (!isRegisteredWiki(wiki, wikiIds, wikiRoots)) return false;
    wikiIds.add(wiki.id);
    wikiRoots.add(wiki.root);
  }

  const workspaceIds = new Set<string>();
  const workspaceNames = new Set<string>();
  const memberships = new Map<string, Set<string>>();
  for (const workspace of value.workspaces) {
    if (!isWikiWorkspace(workspace, wikiIds, workspaceIds, workspaceNames)) {
      return false;
    }
    workspaceIds.add(workspace.id);
    workspaceNames.add(workspace.name.toLowerCase());
    memberships.set(workspace.id, new Set(workspace.wikis));
  }

  const activeWikis = new Set<string>();
  for (const selection of value.active) {
    if (
      !isRecord(selection) ||
      !hasOnlyKeys(selection, ["wiki", "workspace"]) ||
      typeof selection.wiki !== "string" ||
      typeof selection.workspace !== "string" ||
      activeWikis.has(selection.wiki) ||
      !memberships.get(selection.workspace)?.has(selection.wiki)
    ) {
      return false;
    }
    activeWikis.add(selection.wiki);
  }
  return true;
}

/**
 * Validates one persisted registered wiki and its uniqueness.
 *
 * @param value - Unknown wiki entry.
 * @param ids - IDs already observed.
 * @param roots - Roots already observed.
 * @returns Whether the entry is canonical and unique.
 */
function isRegisteredWiki(
  value: unknown,
  ids: ReadonlySet<string>,
  roots: ReadonlySet<string>,
): value is RegisteredWiki {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "name", "root"]) &&
    typeof value.id === "string" &&
    IDENTIFIER_PATTERN.test(value.id) &&
    !ids.has(value.id) &&
    typeof value.name === "string" &&
    isDisplayName(value.name) &&
    typeof value.root === "string" &&
    isCanonicalAbsolutePath(value.root) &&
    !roots.has(value.root)
  );
}

/**
 * Validates one persisted workspace and all membership references.
 *
 * @param value - Unknown workspace entry.
 * @param wikiIds - Complete registered wiki identities.
 * @param ids - Workspace IDs already observed.
 * @param names - Normalized workspace names already observed.
 * @returns Whether the workspace is canonical and unique.
 */
function isWikiWorkspace(
  value: unknown,
  wikiIds: ReadonlySet<string>,
  ids: ReadonlySet<string>,
  names: ReadonlySet<string>,
): value is WikiWorkspace {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "name", "wikis"]) ||
    typeof value.id !== "string" ||
    !IDENTIFIER_PATTERN.test(value.id) ||
    ids.has(value.id) ||
    typeof value.name !== "string" ||
    !isDisplayName(value.name) ||
    names.has(value.name.toLowerCase()) ||
    !Array.isArray(value.wikis) ||
    value.wikis.length < 2 ||
    value.wikis.length > MAX_REGISTERED_WIKIS
  ) {
    return false;
  }
  const members = new Set<string>();
  for (const wiki of value.wikis) {
    if (typeof wiki !== "string" || !wikiIds.has(wiki) || members.has(wiki)) {
      return false;
    }
    members.add(wiki);
  }
  return true;
}

/**
 * Determines whether one display name is bounded and free of control text.
 *
 * @param value - Candidate human-readable name.
 * @returns Whether the name is safe for storage and terminal display.
 */
function isDisplayName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 80 &&
    value.trim() === value &&
    isTerminalSafeText(value)
  );
}

/**
 * Determines whether one path is already canonical, absolute, and bounded.
 *
 * @param value - Candidate persisted repository root.
 * @returns Whether the path is safe to resolve later.
 */
function isCanonicalAbsolutePath(value: string): boolean {
  return (
    value.length > 1 &&
    value.length <= 2_000 &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    isTerminalSafeText(value)
  );
}

/**
 * Checks whether an unknown value is a non-array object.
 *
 * @param value - Candidate value.
 * @returns Whether string-keyed property checks are safe.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks that an object has exactly the allowed own enumerable keys.
 *
 * @param value - Object under validation.
 * @param allowed - Complete allowed key set.
 * @returns Whether no required or extra key is present.
 */
function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === allowed.length && keys.every((key) => allowed.includes(key))
  );
}

/**
 * Canonicalizes and validates one directory.
 *
 * @param directory - Resolvable directory path.
 * @returns Canonical absolute directory path.
 */
async function canonicalDirectory(directory: string): Promise<string> {
  try {
    const canonical = await realpath(path.resolve(directory));
    if (!(await lstat(canonical)).isDirectory())
      throw new Error("not directory");
    return canonical;
  } catch {
    throw new WikiWorkspaceError("The wiki location does not exist.");
  }
}

/**
 * Walks lexically upward until a real existing directory can be canonicalized.
 *
 * @param location - Absolute complete or partial filesystem path.
 * @returns Canonical nearest existing directory.
 * @throws {WikiWorkspaceError} When no usable ancestor can be inspected.
 */
async function nearestExistingDirectory(location: string): Promise<string> {
  let candidate = path.resolve(location);
  while (true) {
    try {
      const canonical = await realpath(candidate);
      if ((await lstat(canonical)).isDirectory()) return canonical;
    } catch (error) {
      if (!isExpectedDiscoveryError(error)) {
        throw new WikiWorkspaceError("Unable to inspect the repository path.");
      }
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new WikiWorkspaceError("Unable to inspect the repository path.");
    }
    candidate = parent;
  }
}

/**
 * Checks whether a directory is a Git repository with OpenWiki run metadata.
 *
 * @param directory - Canonical candidate repository root.
 * @returns Whether the directory exposes a linkable repository wiki.
 */
async function isWikiRepository(directory: string): Promise<boolean> {
  return (
    (await isGitRepository(directory)) && (await hasOpenWikiMetadata(directory))
  );
}

/**
 * Checks whether a repository contains the OpenWiki discovery marker.
 *
 * @param directory - Canonical repository root.
 * @returns Whether OpenWiki has recorded repository run metadata.
 */
async function hasOpenWikiMetadata(directory: string): Promise<boolean> {
  return isRegularFile(path.join(directory, UPDATE_METADATA_PATH));
}

/**
 * Checks for a directory or worktree-file Git marker.
 *
 * @param directory - Canonical candidate repository root.
 * @returns Whether the directory has a Git marker.
 */
async function isGitRepository(directory: string): Promise<boolean> {
  try {
    const marker = await lstat(path.join(directory, ".git"));
    return marker.isDirectory() || marker.isFile();
  } catch (error) {
    if (isExpectedDiscoveryError(error)) return false;
    throw error;
  }
}

/**
 * Checks whether one path is an ordinary file without following a final symlink.
 *
 * @param filePath - Absolute candidate file path.
 * @returns Whether the path is a regular file.
 */
async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isFile();
  } catch (error) {
    if (isExpectedDiscoveryError(error)) return false;
    throw error;
  }
}

/**
 * Reads one discovery directory while tolerating inaccessible descendants.
 *
 * @param directory - Canonical directory being traversed.
 * @returns Directory entries available to the current user.
 */
async function readDiscoveryDirectory(
  directory: string,
): Promise<Dirent<string>[]> {
  try {
    return await readdir(directory, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if (isExpectedDiscoveryError(error)) return [];
    throw new WikiWorkspaceError("Unable to inspect the wiki location.");
  }
}

/**
 * Identifies missing, moved, or inaccessible paths expected during scanning.
 *
 * @param error - Unknown filesystem failure.
 * @returns Whether discovery may safely treat the path as unavailable.
 */
function isExpectedDiscoveryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && EXPECTED_DISCOVERY_ERROR_CODES.has(code);
}

/**
 * Determines whether one directory entry is safe and useful to traverse.
 *
 * @param entry - Candidate child entry.
 * @returns Whether discovery may inspect the child directory.
 */
function isDiscoverableDirectory(entry: Dirent<string>): boolean {
  return (
    entry.isDirectory() &&
    !entry.isSymbolicLink() &&
    !entry.name.startsWith(".") &&
    isTerminalSafeText(entry.name) &&
    !IGNORED_DISCOVERY_DIRECTORIES.has(entry.name)
  );
}

/**
 * Creates one repository-finder entry and checks its OpenWiki marker.
 *
 * @param displayRoot - Directory against which the path should be displayed.
 * @param repositoryRoot - Canonical repository root.
 * @returns Display metadata and linkability for one Git repository.
 */
async function discoveredRepository(
  displayRoot: string,
  repositoryRoot: string,
): Promise<DiscoveredRepository> {
  return {
    ...discoveredRepositoryMetadata(displayRoot, repositoryRoot),
    hasOpenWiki: await hasOpenWikiMetadata(repositoryRoot),
  };
}

/**
 * Creates terminal-safe display metadata shared by finder and selected rows.
 *
 * @param displayRoot - Directory against which the path should be displayed.
 * @param repositoryRoot - Canonical repository root.
 * @returns Display metadata for one Git repository.
 */
function discoveredRepositoryMetadata(
  displayRoot: string,
  repositoryRoot: string,
): Omit<DiscoveredRepository, "hasOpenWiki"> {
  const relative = path.relative(displayRoot, repositoryRoot);
  const name = path.basename(repositoryRoot);
  const displayPath =
    relative && !relative.startsWith("..") ? relative : repositoryRoot;
  if (!isTerminalSafeText(name) || !isTerminalSafeText(displayPath)) {
    throw new WikiWorkspaceError(
      "A repository path contains terminal control characters and cannot be linked safely.",
    );
  }
  return {
    root: repositoryRoot,
    name,
    path: displayPath,
  };
}

/**
 * Checks that filesystem text cannot inject terminal control sequences.
 *
 * @param value - Candidate display text.
 * @returns Whether every character is printable terminal text.
 */
function isTerminalSafeText(value: string): boolean {
  return [...value].every(
    (character) => character >= " " && character !== "\u007f",
  );
}

/**
 * Resolves a user path with explicit home-directory expansion.
 *
 * @param value - User-entered path.
 * @param baseDirectory - Base for relative paths.
 * @returns Absolute lexical path.
 */
function resolveUserPath(value: string, baseDirectory: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(baseDirectory, trimmed || ".");
}

/**
 * Creates a local-only wiki identity for an unregistered repository.
 *
 * @param root - Canonical repository root.
 * @returns Ephemeral client-facing wiki entry.
 */
function localWiki(root: string): RegisteredWiki {
  const name = path.basename(root);
  return { id: slugIdentifier(name, "wiki"), name, root };
}

/**
 * Converts a display name to a bounded stable identifier base.
 *
 * @param value - Human-readable name.
 * @param fallback - Identifier used when no alphanumeric text remains.
 * @returns Lowercase identifier base.
 */
function slugIdentifier(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 56)
    .replace(/-+$/u, "");
  return slug || fallback;
}

/**
 * Adds the smallest numeric suffix needed for uniqueness.
 *
 * @param preferred - Preferred bounded identifier.
 * @param used - IDs already assigned.
 * @returns Unique identifier.
 */
function uniqueIdentifier(
  preferred: string,
  used: ReadonlySet<string>,
): string {
  if (!used.has(preferred)) return preferred;
  let suffix = 2;
  while (used.has(`${preferred}-${suffix}`)) suffix += 1;
  return `${preferred}-${suffix}`;
}

/**
 * Sorts workspaces by human name and stable identity.
 *
 * @param left - First workspace.
 * @param right - Second workspace.
 * @returns Locale comparison result.
 */
function compareWorkspaces(left: WikiWorkspace, right: WikiWorkspace): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

/**
 * Creates stable repair guidance for malformed persisted state.
 *
 * @returns Bounded workspace registry error.
 */
function invalidRegistryError(): WikiWorkspaceError {
  return new WikiWorkspaceError(
    `The ${WIKI_WORKSPACES_FILE} file is invalid. Fix or remove it, then rerun openwiki link.`,
  );
}

/**
 * Creates stable repair guidance for unavailable registered repositories.
 *
 * @returns Bounded stale-workspace error.
 */
function staleWorkspaceError(): WikiWorkspaceError {
  return new WikiWorkspaceError(
    "A selected workspace contains an unavailable repository wiki. Repair it with openwiki link.",
  );
}
