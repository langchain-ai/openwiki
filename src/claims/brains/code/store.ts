import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ClaimsPageMissingError,
  ClaimsPersistenceError,
  ClaimsPersistenceSecurityError,
} from "../../core/errors.js";
import {
  CLAIMS_DIRECTORY,
  isGroundedWikiPage,
  normalizeWikiPagePath,
  toClaimsSidecarRelativePath,
  toRepositoryPagePath,
} from "./paths.js";
import { CODE_CLAIMS_SCHEMA_VERSION, type PageClaims } from "./types.js";

/**
 * Runtime validator for one canonical non-empty persisted string.
 */
const CanonicalNonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), {
    message: "Must not contain surrounding whitespace",
  });

/**
 * Runtime validator for one persisted evidence record.
 */
const EvidenceSchema = z
  .object({
    resource: CanonicalNonEmptyStringSchema,
    version: CanonicalNonEmptyStringSchema,
  })
  .strict();

/**
 * Runtime validator for one persisted claim.
 */
const ClaimSchema = z
  .object({
    id: CanonicalNonEmptyStringSchema,
    statement: CanonicalNonEmptyStringSchema,
    evidence: z.array(EvidenceSchema).min(1),
  })
  .strict();

/**
 * Runtime validator for one durable machine-verification event.
 */
const VerificationSchema = z
  .object({
    by: CanonicalNonEmptyStringSchema,
    at: CanonicalNonEmptyStringSchema,
  })
  .strict();

/**
 * Runtime validator for one V1 page sidecar.
 */
const PageClaimsSchema = z
  .object({
    schemaVersion: z.literal(CODE_CLAIMS_SCHEMA_VERSION),
    pageVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    claims: z.array(ClaimSchema),
    verification: VerificationSchema.optional(),
  })
  .strict();

/**
 * OpenWiki-owned claim persistence rooted in one repository.
 */
export class ClaimsStore {
  /**
   * Absolute repository root.
   */
  private readonly rootDir: string;

  /**
   * Lazily resolved physical repository root.
   *
   * @default undefined until the first filesystem operation.
   */
  private realRootDirPromise?: Promise<string>;

  /**
   * Absolute generated-wiki root.
   */
  private readonly wikiDir: string;

  /**
   * Absolute sidecar root.
   */
  private readonly claimsDir: string;

  constructor(rootDir: string) {
    if (!path.isAbsolute(rootDir)) {
      throw new ClaimsPersistenceError(
        "Claims store root must be an absolute path.",
      );
    }

    this.rootDir = path.resolve(rootDir);
    this.wikiDir = path.join(this.rootDir, "openwiki");
    this.claimsDir = path.join(this.wikiDir, CLAIMS_DIRECTORY);
  }

  /**
   * Discovers generated Markdown pages that own factual claim state.
   *
   * @returns Stable-order virtual page paths.
   */
  async discoverPages(): Promise<string[]> {
    const wikiDir = await this.resolveExistingDirectory(this.wikiDir);
    if (!wikiDir) {
      return [];
    }
    const files = await collectRegularFiles(wikiDir, false);
    return files
      .map((file) => `/openwiki/${file.replace(/\\/gu, "/")}`)
      .filter(isGroundedWikiPage)
      .sort((left, right) => left.localeCompare(right));
  }

  /**
   * Discovers persisted sidecars, including orphans.
   *
   * @returns Stable-order virtual page paths represented by sidecars.
   */
  async discoverSidecarPages(): Promise<string[]> {
    const claimsDir = await this.resolveExistingDirectory(this.claimsDir);
    if (!claimsDir) {
      return [];
    }
    const files = await collectRegularFiles(claimsDir, true);
    return files
      .filter((file) => file.endsWith(".json"))
      .map(
        (file) =>
          `/openwiki/${file.replace(/\\/gu, "/").replace(/\.json$/u, ".md")}`,
      )
      .filter(isGroundedWikiPage)
      .sort((left, right) => left.localeCompare(right));
  }

  /**
   * Loads and validates one page sidecar.
   *
   * @param page - Virtual generated-page path.
   * @returns Valid persisted state, or `null` when no sidecar exists.
   */
  async loadPage(page: string): Promise<PageClaims | null> {
    const sidecar = this.sidecarPath(page);
    const physicalSidecar = await this.resolveExistingRegularFile(sidecar);
    if (!physicalSidecar) {
      return null;
    }
    let raw: string;
    try {
      raw = await readFile(physicalSidecar, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw new ClaimsPersistenceError(
        `Unable to read ${this.displayPath(sidecar)}: ${toErrorMessage(error)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ClaimsPersistenceError(
        `Invalid JSON in ${this.displayPath(sidecar)}: ${toErrorMessage(error)}`,
      );
    }

    return validatePageClaims(
      parsed,
      `claim sidecar ${this.displayPath(sidecar)}`,
    );
  }

  /**
   * Loads sidecars for generated pages without creating missing state.
   *
   * @param pages - Virtual generated-page paths.
   * @returns Page-to-sidecar map containing only existing sidecars.
   */
  async loadPages(pages: readonly string[]): Promise<Map<string, PageClaims>> {
    const result = new Map<string, PageClaims>();
    for (const page of pages) {
      const persisted = await this.loadPage(page);
      if (persisted) {
        result.set(normalizeWikiPagePath(page), persisted);
      }
    }
    return result;
  }

  /**
   * Hashes the current generated Markdown for synchronization checks.
   *
   * @param page - Virtual generated-page path.
   * @returns Algorithm-prefixed page version.
   */
  async hashPage(page: string): Promise<string> {
    const pagePath = path.join(this.rootDir, toRepositoryPagePath(page));
    const physicalPage = await this.resolveExistingRegularFile(pagePath);
    if (!physicalPage) {
      throw new ClaimsPageMissingError(
        `Unable to hash ${normalizeWikiPagePath(page)}: file does not exist`,
      );
    }
    try {
      const content = await readFile(physicalPage);
      return `sha256:${createHash("sha256").update(content).digest("hex")}`;
    } catch (error) {
      throw new ClaimsPersistenceError(
        `Unable to hash ${normalizeWikiPagePath(page)}: ${toErrorMessage(error)}`,
      );
    }
  }

  /**
   * Reads one generated Markdown page through the Claims path-containment gate.
   *
   * @param page - Virtual generated-page path.
   * @returns Exact UTF-8 Markdown bytes as text.
   */
  async readMarkdown(page: string): Promise<string> {
    const normalizedPage = normalizeWikiPagePath(page);
    const pagePath = path.join(this.rootDir, toRepositoryPagePath(page));
    const physicalPage = await this.resolveExistingRegularFile(pagePath);
    if (!physicalPage) {
      throw new ClaimsPageMissingError(
        `Unable to read ${normalizedPage}: file does not exist`,
      );
    }
    try {
      return await readFile(physicalPage, "utf8");
    } catch (error) {
      throw new ClaimsPersistenceError(
        `Unable to read ${normalizedPage}: ${toErrorMessage(error)}`,
      );
    }
  }

  /**
   * Writes one existing generated Markdown page after resolving it through the
   * Claims path-containment gate. Writing the resolved regular file directly
   * preserves its permissions and prevents path aliases from redirecting the
   * projection outside the repository.
   *
   * @param page - Virtual generated-page path.
   * @param content - Complete replacement Markdown.
   */
  async writeMarkdown(page: string, content: string): Promise<void> {
    const normalizedPage = normalizeWikiPagePath(page);
    const pagePath = path.join(this.rootDir, toRepositoryPagePath(page));
    const physicalPage = await this.resolveExistingRegularFile(pagePath);
    if (!physicalPage) {
      throw new ClaimsPageMissingError(
        `Unable to write ${normalizedPage}: file does not exist`,
      );
    }
    try {
      await writeFile(physicalPage, content, "utf8");
    } catch (error) {
      throw new ClaimsPersistenceError(
        `Unable to write ${normalizedPage}: ${toErrorMessage(error)}`,
      );
    }
  }

  /**
   * Atomically persists one synchronized page sidecar.
   *
   * @param page - Virtual generated-page path.
   * @param pageClaims - Complete synchronized page state.
   */
  async writePage(page: string, pageClaims: PageClaims): Promise<void> {
    const normalizedPage = normalizeWikiPagePath(page);
    const validated = validatePageClaims(
      pageClaims,
      `claims for ${normalizedPage}`,
    );

    const sidecar = this.sidecarPath(page);
    const directory = path.dirname(sidecar);
    const physicalDirectory = await this.ensureContainedDirectory(directory);
    const physicalSidecar = path.join(
      physicalDirectory,
      path.basename(sidecar),
    );
    const temporary = path.join(
      physicalDirectory,
      `.${path.basename(sidecar)}.${randomUUID()}.tmp`,
    );

    try {
      await writeFile(
        temporary,
        `${JSON.stringify(validated, null, 2)}\n`,
        "utf8",
      );
      await rename(temporary, physicalSidecar);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new ClaimsPersistenceError(
        `Unable to persist ${this.displayPath(sidecar)}: ${toErrorMessage(error)}`,
      );
    }
  }

  /**
   * Deletes one page sidecar after successful page deletion or orphan cleanup.
   *
   * @param page - Virtual page represented by the sidecar.
   */
  async deletePage(page: string): Promise<void> {
    const sidecar = this.sidecarPath(page);
    const directory = await this.resolveExistingDirectory(
      path.dirname(sidecar),
    );
    if (!directory) {
      return;
    }
    try {
      await rm(path.join(directory, path.basename(sidecar)), { force: true });
    } catch (error) {
      throw new ClaimsPersistenceError(
        `Unable to remove claims for ${normalizeWikiPagePath(page)}: ${toErrorMessage(error)}`,
      );
    }
  }

  /**
   * Resolves a page's absolute sidecar path.
   *
   * @param page - Virtual generated-page path.
   * @returns Absolute contained sidecar path.
   */
  private sidecarPath(page: string): string {
    return path.join(this.claimsDir, toClaimsSidecarRelativePath(page));
  }

  /**
   * Converts an absolute repository path into diagnostic form.
   *
   * @param absolutePath - Absolute contained filesystem path.
   * @returns Repository-relative POSIX path.
   */
  private displayPath(absolutePath: string): string {
    return path.relative(this.rootDir, absolutePath).replace(/\\/gu, "/");
  }

  /**
   * Resolves an existing contained regular file without following aliases.
   *
   * @param absolutePath - Expected lexical path below the repository root.
   * @returns Canonical physical path, or `null` when absent.
   */
  private async resolveExistingRegularFile(
    absolutePath: string,
  ): Promise<string | null> {
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw new ClaimsPersistenceError(
        `Unable to inspect ${this.displayPath(absolutePath)}: ${toErrorMessage(error)}`,
      );
    }
    if (metadata.isSymbolicLink()) {
      throw new ClaimsPersistenceSecurityError(
        `Claims path cannot be a symbolic link: ${this.displayPath(absolutePath)}`,
      );
    }
    if (!metadata.isFile()) {
      throw new ClaimsPersistenceError(
        `Claims path is not a regular file: ${this.displayPath(absolutePath)}`,
      );
    }

    const physicalPath = await this.resolvePhysicalPath(absolutePath);
    return physicalPath;
  }

  /**
   * Resolves an existing contained directory without following aliases.
   *
   * @param absolutePath - Expected lexical path below the repository root.
   * @returns Canonical physical path, or `null` when absent.
   */
  private async resolveExistingDirectory(
    absolutePath: string,
  ): Promise<string | null> {
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw new ClaimsPersistenceError(
        `Unable to inspect ${this.displayPath(absolutePath)}: ${toErrorMessage(error)}`,
      );
    }
    if (metadata.isSymbolicLink()) {
      throw new ClaimsPersistenceSecurityError(
        `Claims path cannot be a symbolic link: ${this.displayPath(absolutePath)}`,
      );
    }
    if (!metadata.isDirectory()) {
      throw new ClaimsPersistenceError(
        `Claims path is not a directory: ${this.displayPath(absolutePath)}`,
      );
    }

    return this.resolvePhysicalPath(absolutePath);
  }

  /**
   * Creates a contained directory after validating every existing ancestor.
   *
   * @param absolutePath - Expected lexical directory below the repository root.
   * @returns Canonical physical directory path.
   */
  private async ensureContainedDirectory(
    absolutePath: string,
  ): Promise<string> {
    const relative = path.relative(this.rootDir, absolutePath);
    if (!isPathInside(this.rootDir, absolutePath)) {
      throw new ClaimsPersistenceSecurityError(
        `Claims directory escapes the repository: ${relative}`,
      );
    }

    let current = this.rootDir;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let metadata;
      try {
        metadata = await lstat(current);
      } catch (error) {
        if (isMissingFileError(error)) {
          break;
        }
        throw new ClaimsPersistenceError(
          `Unable to inspect ${this.displayPath(current)}: ${toErrorMessage(error)}`,
        );
      }
      if (metadata.isSymbolicLink()) {
        throw new ClaimsPersistenceSecurityError(
          `Claims path cannot be a symbolic link: ${this.displayPath(current)}`,
        );
      }
      if (!metadata.isDirectory()) {
        throw new ClaimsPersistenceError(
          `Claims path is not a directory: ${this.displayPath(current)}`,
        );
      }
      await this.resolvePhysicalPath(current);
    }

    try {
      await mkdir(absolutePath, { recursive: true });
    } catch (error) {
      throw new ClaimsPersistenceError(
        `Unable to create ${this.displayPath(absolutePath)}: ${toErrorMessage(error)}`,
      );
    }
    const physicalPath = await this.resolveExistingDirectory(absolutePath);
    if (!physicalPath) {
      throw new ClaimsPersistenceError(
        `Claims directory disappeared while being created: ${this.displayPath(absolutePath)}`,
      );
    }
    return physicalPath;
  }

  /**
   * Resolves a path physically and verifies its canonical repository location.
   *
   * @param absolutePath - Existing lexical path below the repository root.
   * @returns Canonical physical path.
   */
  private async resolvePhysicalPath(absolutePath: string): Promise<string> {
    let physicalPath: string;
    try {
      physicalPath = await realpath(absolutePath);
    } catch (error) {
      throw new ClaimsPersistenceError(
        `Unable to resolve ${this.displayPath(absolutePath)}: ${toErrorMessage(error)}`,
      );
    }

    const realRootDir = await this.getRealRootDir();
    const expectedPath = path.resolve(
      realRootDir,
      path.relative(this.rootDir, absolutePath),
    );
    if (
      !isPathInside(realRootDir, physicalPath) ||
      physicalPath !== expectedPath
    ) {
      throw new ClaimsPersistenceSecurityError(
        `Claims path traverses a symbolic link or filesystem alias: ${this.displayPath(absolutePath)}`,
      );
    }
    return physicalPath;
  }

  /**
   * Resolves and caches the physical repository root.
   *
   * @returns Canonical repository root path.
   */
  private async getRealRootDir(): Promise<string> {
    this.realRootDirPromise ??= realpath(this.rootDir).catch(
      (error: unknown) => {
        throw new ClaimsPersistenceSecurityError(
          `Unable to resolve claims root ${this.rootDir}: ${toErrorMessage(error)}`,
        );
      },
    );
    return this.realRootDirPromise;
  }
}

/**
 * Validates complete page state and cross-record uniqueness constraints.
 *
 * @param value - Unknown sidecar-shaped value.
 * @param description - Safe diagnostic description of the value's owner.
 * @returns Validated page claims without structural aliases.
 */
function validatePageClaims(value: unknown, description: string): PageClaims {
  const validation = PageClaimsSchema.safeParse(value);
  if (!validation.success) {
    throw new ClaimsPersistenceError(
      `Invalid ${description}: ${validation.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const ids = new Set<string>();
  for (const claim of validation.data.claims) {
    if (ids.has(claim.id)) {
      throw new ClaimsPersistenceError(
        `Duplicate claim id ${claim.id} in ${description}`,
      );
    }
    ids.add(claim.id);

    const resources = new Set<string>();
    for (const evidence of claim.evidence) {
      if (resources.has(evidence.resource)) {
        throw new ClaimsPersistenceError(
          `Duplicate evidence resource ${evidence.resource} for claim ${claim.id} in ${description}`,
        );
      }
      resources.add(evidence.resource);
    }
  }

  return validation.data;
}

/**
 * Recursively collects regular files without traversing symbolic links.
 *
 * Missing roots produce an empty collection so a repository can begin without
 * an existing wiki or sidecar directory.
 *
 * @param root - Absolute directory to walk.
 * @param includeClaimsDirectory - Whether `.claims` directories may be traversed.
 * @returns Paths relative to the supplied root.
 */
async function collectRegularFiles(
  root: string,
  includeClaimsDirectory: boolean,
): Promise<string[]> {
  const results: string[] = [];

  /**
   * Walks one contained directory.
   *
   * @param directory - Absolute directory currently being visited.
   * @param relativeDirectory - Path relative to the original root.
   */
  async function walk(
    directory: string,
    relativeDirectory: string,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw new ClaimsPersistenceError(
        `Unable to enumerate ${directory}: ${toErrorMessage(error)}`,
      );
    }

    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relative = path.join(relativeDirectory, entry.name);
      const absolute = path.join(directory, entry.name);
      let metadata;
      try {
        metadata = await lstat(absolute);
      } catch (error) {
        if (isMissingFileError(error)) {
          continue;
        }
        throw new ClaimsPersistenceError(
          `Unable to inspect ${absolute}: ${toErrorMessage(error)}`,
        );
      }
      if (metadata.isSymbolicLink()) {
        continue;
      }
      if (metadata.isDirectory()) {
        if (
          !includeClaimsDirectory &&
          entry.name.toLowerCase() === CLAIMS_DIRECTORY
        ) {
          continue;
        }
        await walk(absolute, relative);
      } else if (metadata.isFile()) {
        results.push(relative);
      }
    }
  }

  await walk(root, "");
  return results;
}

/**
 * Determines whether an absolute path is strictly below an absolute root.
 *
 * @param rootDir - Absolute containing directory.
 * @param candidate - Absolute candidate path.
 * @returns Whether the candidate remains below the root.
 */
function isPathInside(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Determines whether a filesystem error means a path is absent.
 *
 * @param error - Unknown filesystem failure.
 * @returns Whether the error is `ENOENT`.
 */
function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Converts an unknown thrown value into diagnostic text.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable detail.
 */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
