/**
 * The repository's directory tree, and whether a proposed partition covers it.
 *
 * Two rules have now failed here. The first tried to decide what a component IS
 * - manifests, containers, migration lineages - and returned 213 units for one
 * repository, counting every CI workflow and every benchmark fixture's
 * Dockerfile. The second surveyed top-level directories, which is not a rule
 * about repositories at all: it fits a flat monorepo with thirty-four of them
 * and produces one surveyor for the whole codebase in a repository that keeps
 * everything under src/, or one for `packages/` in a repository nested as
 * packages/@org/*.
 *
 * There is no mechanical answer, because the right granularity is a fact about
 * how a particular repository is organised. But there is a mechanical CHECK.
 * So this enumerates the tree and verifies a partition against it, and the
 * partition itself comes from an agent that has looked at the repository.
 *
 * That keeps the property worth having. A subtree nobody surveys is invisible -
 * nothing downstream can tell it apart from a subtree that does not exist - and
 * this makes such a subtree a rejection with its path in the message rather than
 * a silent gap. Choosing granularity is judgement; noticing an omission is not.
 *
 * Test directories are excluded as subjects, never as evidence. Nothing here
 * restricts what an author reads: a page's tests are among its best evidence,
 * and both the page contract and the author prompt ask for them by name.
 */

import path from "node:path";

/** Directories that are never a subject, and expensive to walk. */
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "openwiki",
  // The agent's own spill directory, not a subject. The docs-only backend writes
  // an over-limit tool result to /large_tool_results/<id>.txt, so this appears
  // partway through a run: the coverage walk then reported an area the listing
  // had never shown, which the plan could neither document nor exclude.
  "large_tool_results",
]);

/**
 * Directory names that mark a test tree.
 *
 * Name-based, which is a rule - but a far safer one than "is this a component".
 * Being wrong here costs a directory being surveyed as evidence rather than as
 * a subject, and its contents still reach pages through the tests their authors
 * are told to read.
 */
const TEST_DIRECTORIES = new Set([
  "test",
  "tests",
  "testdata",
  "spec",
  "specs",
  "fixture",
  "fixtures",
  "e2e",
  "benchmarks",
  "mocks",
]);

/** Backend capability needed to enumerate. */
export interface ListingBackend {
  ls(dirPath: string): Promise<{
    error?: string;
    files?: { path: string; is_dir?: boolean }[];
  }>;
}

/**
 * Depth of the tree shown to the agent when it plans.
 *
 * A display bound, not a correctness one. It exists so the listing stays
 * readable on a large monorepo; coverage checking does not use it and is not
 * limited by it, because a directory the agent never saw still has to be
 * covered by some ancestor entry.
 */
const LISTING_DEPTH = 3;

/**
 * Reports whether a directory name marks a test tree.
 *
 * @param name - Bare directory name.
 * @returns Whether it should be evidence rather than a subject.
 */
export function isTestDirectory(name: string): boolean {
  // Normalized so test_data, test-data, and testdata are one name. A run
  // planned a page for /test_data because only the undelimited spelling was
  // listed, which is a naming accident rather than a judgement.
  return TEST_DIRECTORIES.has(name.toLowerCase().replace(/[-_]/gu, ""));
}

/**
 * Reports whether a directory should be walked at all.
 *
 * @param name - Bare directory name.
 * @returns Whether it is a subject worth accounting for.
 */
function isWalkable(name: string): boolean {
  if (SKIP_DIRECTORIES.has(name) || isTestDirectory(name)) {
    return false;
  }
  // Dotted directories are tooling, with one exception: .github carries the
  // repository's whole operational surface.
  return !name.startsWith(".") || name === ".github";
}

/**
 * One planning view per backend.
 *
 * The counting walk visits every directory, and plan validation runs on each
 * submit_plan call, so without this a long planning phase would re-walk the
 * repository dozens of times. A run's tree does not change under it: the wiki
 * directory is excluded from the walk.
 */
const PLANNING_VIEWS = new WeakMap<
  ListingBackend,
  { directories: string[]; sourceFiles: ReadonlyMap<string, number> }
>();

/** Extensions counted as documentable source. */
// prettier-ignore
const SOURCE_EXTENSIONS = new Set([
  ".go", ".py", ".ts", ".tsx", ".js", ".jsx", ".rs", ".java", ".kt", ".scala",
  ".rb", ".php", ".cs", ".swift", ".m", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".sql", ".proto", ".sh",
]);

/** Names that mark a file as a test, wherever it sits. */
const TEST_FILE = /(_test\.|\.test\.|\.spec\.|^test_|^conftest\.py$|_tests\.)/u;

/** Names that mark a file as generated rather than written. */
const GENERATED_FILE = /(\.pb\.|_pb2\.|_grpc\.py$|\.generated\.|zz_generated)/u;

/**
 * Reports whether a file is source a page could be written about.
 *
 * Test and generated files are excluded because they scale with things other
 * than how much there is to document - test volume follows a project's testing
 * culture, and generated volume follows its schema size.
 *
 * @param name - Bare file name.
 * @returns Whether it counts towards documentable volume.
 */
export function isDocumentableSource(name: string): boolean {
  if (TEST_FILE.test(name) || GENERATED_FILE.test(name)) {
    return false;
  }
  return SOURCE_EXTENSIONS.has(path.posix.extname(name).toLowerCase());
}

/**
 * Lists the walkable child directories of one directory.
 *
 * @param backend - Filesystem backend.
 * @param directory - Repository-rooted path, "" for the root.
 * @returns Child paths, rooted at "/".
 */
async function childDirectories(
  backend: ListingBackend,
  directory: string,
): Promise<string[]> {
  const listed = await backend.ls(directory === "" ? "/" : directory);
  const children: string[] = [];
  for (const entry of listed.files ?? []) {
    if (!entry.is_dir) {
      continue;
    }
    const name = path.posix.basename(entry.path.replace(/\/+$/u, ""));
    if (isWalkable(name)) {
      children.push(`${directory}/${name}`);
    }
  }
  return children;
}

/**
 * Enumerates directories for the agent to plan against, bounded for readability.
 *
 * @param backend - Filesystem backend rooted at the repository.
 * @returns Repository-rooted paths, sorted, plus "/" for the root's own files.
 */
export async function collectDirectoryTree(
  backend: ListingBackend,
): Promise<string[]> {
  return (await collectPlanningView(backend)).directories;
}

/**
 * The planning view: the same bounded directory list, plus how much documentable
 * source each directory holds directly.
 *
 * Both come out of one walk because `ls` returns files alongside directories, so
 * counting costs no extra listings.
 *
 * @param backend - Filesystem backend rooted at the repository.
 * @returns Sorted directories, and documentable file counts per directory.
 */
export async function collectPlanningView(backend: ListingBackend): Promise<{
  directories: string[];
  sourceFiles: ReadonlyMap<string, number>;
}> {
  const cached = PLANNING_VIEWS.get(backend);
  if (cached) {
    return cached;
  }
  const directories: string[] = ["/"];
  const sourceFiles = new Map<string, number>();

  // Unbounded, unlike the directory listing. A subtree total that stopped at
  // LISTING_DEPTH would omit most of a deep repository's source and understate
  // every area that holds any, so the count walks the whole tree while the
  // listing stays bounded for readability.
  const walk = async (directory: string, depth: number): Promise<number> => {
    const listed = await backend.ls(directory === "" ? "/" : directory);
    let total = 0;
    const children: string[] = [];
    for (const entry of listed.files ?? []) {
      const name = path.posix.basename(entry.path.replace(/\/+$/u, ""));
      if (entry.is_dir) {
        if (isWalkable(name)) {
          children.push(`${directory}/${name}`);
        }
      } else if (isDocumentableSource(name)) {
        total += 1;
      }
    }
    for (const child of children) {
      if (depth < LISTING_DEPTH) {
        directories.push(child);
      }
      total += await walk(child, depth + 1);
    }
    sourceFiles.set(directory === "" ? "/" : directory, total);
    return total;
  };
  await walk("", 0);
  directories.sort();
  const view = { directories, sourceFiles };
  PLANNING_VIEWS.set(backend, view);
  return view;
}

/**
 * Normalizes a supplied directory to a rooted path with no trailing slash.
 *
 * @param directory - Model-supplied path.
 * @returns Rooted path.
 */
function rooted(directory: string): string {
  return `/${directory.replace(/^\/+/u, "").replace(/\/+$/u, "")}`;
}

/**
 * Reports whether any entry covers a directory.
 *
 * @param directory - Rooted directory path.
 * @param entries - Rooted entry directories.
 * @returns Whether the directory falls under an entry.
 */
function isCovered(directory: string, entries: readonly string[]): boolean {
  // "/" covers only itself - the repository's own files, which belong to no
  // subdirectory. If it covered the whole tree the coverage guarantee would be
  // vacuous: a single root entry would satisfy it for every directory in the
  // repository. A plan has to name the areas it documents.
  return entries.some(
    (entry) => directory === entry || directory.startsWith(`${entry}/`),
  );
}

/**
 * Finds directories no entry covers, to any depth.
 *
 * Unbounded in depth but cheap, because coverage is inherited: once a directory
 * is covered every directory beneath it is too, so the walk prunes there and
 * never descends. Under a complete plan it therefore visits only the top of the
 * tree. An uncovered directory is reported and then pruned as well, so a missed
 * subtree yields the one path that names it rather than hundreds of its
 * children.
 *
 * A depth bound here would put a hole in the only guarantee this makes: a
 * service nested deeper than the bound would never be enumerated, so nothing
 * would require the plan to cover it, which is the invisible subtree the check
 * exists to prevent.
 *
 * @param backend - Filesystem backend rooted at the repository.
 * @param entries - Directories the plan claims to cover.
 * @returns Uncovered directories, shallowest first.
 */
export async function findUncoveredDirectories(
  backend: ListingBackend,
  entries: readonly string[],
): Promise<string[]> {
  const covering = entries.map(rooted);
  // The repository's own files belong to no subdirectory, so only an entry on
  // "/" covers them. Without this they would go unaccounted for silently.
  const uncovered: string[] = isCovered("/", covering) ? [] : ["/"];

  const walk = async (directory: string): Promise<void> => {
    const children = await childDirectories(backend, directory);
    for (const child of children) {
      if (!isCovered(child, covering)) {
        // Report the highest uncovered directory and stop. Its children add
        // nothing a reader can act on, and listing them would turn one missed
        // subtree into hundreds of problems.
        uncovered.push(child);
        continue;
      }
      // Covered, so everything beneath it is covered too - unless a deeper
      // entry exists, which means this subtree was partitioned and something
      // inside it may still have been missed.
      if (covering.some((entry) => entry.startsWith(`${child}/`))) {
        await walk(child);
      }
    }
  };
  await walk("");
  return uncovered;
}
