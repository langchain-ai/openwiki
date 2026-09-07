import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { OpenWikiIgnore } from "../agent/openwiki-ignore.js";
import { ClaimsError } from "../claims/core/errors.js";
import type { Evidence } from "../claims/core/types.js";
import { RepositoryEvidenceResolver } from "../claims/evidence/repository/resolver.js";
import { isFileNotFoundError } from "../platform/fs-errors.js";
import {
  REFLECTION_ID_PATTERN,
  REFLECTIONS_DIRECTORY,
  ReflectionProposalSchema,
  ReflectionSchema,
  serializeReflection,
  type Reflection,
  type ReflectionCreated,
  type ReflectionProposal,
} from "./reflection-types.js";

/**
 * Expected reflection failure with correction guidance safe to expose through MCP.
 */
export class ReflectionError extends Error {
  /**
   * Creates a bounded storage or evidence validation error.
   *
   * @param message - Explanation of how the caller can correct the operation.
   */
  constructor(message: string) {
    super(message);
    this.name = "ReflectionError";
  }
}

/**
 * Readable pending discoveries and any gaps in the local inventory.
 */
export interface ReflectionInventory {
  /**
   * Valid local records, each once in stable filename order.
   */
  reflections: Reflection[];

  /**
   * Why some pending files could not be read; other readable records remain available.
   */
  unavailable?: string;
}

/**
 * Append-only reflection storage with contained paths and atomic publication.
 */
export class ReflectionStore {
  /**
   * Absolute repository root owning the reflection directory.
   */
  private readonly root: string;

  /**
   * Creates a repository-local store without creating any files or directories.
   *
   * @param root - Absolute Git repository root.
   */
  constructor(root: string) {
    if (!path.isAbsolute(root))
      throw new ReflectionError(
        "Reflection storage requires an absolute repository root.",
      );
    this.root = path.resolve(root);
  }

  /**
   * Captures source versions and publishes one new pending discovery.
   *
   * @param proposal - Finding and source resources supplied by the agent.
   * @returns New artifact identity without echoing its finding or evidence.
   */
  async create(proposal: ReflectionProposal): Promise<ReflectionCreated> {
    const parsed = ReflectionProposalSchema.safeParse(proposal);
    if (!parsed.success)
      throw new ReflectionError(
        "Provide a non-empty finding and at least one evidence resource; evidence versions are captured by OpenWiki.",
      );
    const resolver = new RepositoryEvidenceResolver({
      rootDir: this.root,
      openWikiIgnore: await OpenWikiIgnore.load(this.root),
    });
    const evidence: Evidence[] = [];
    for (const proposed of parsed.data.evidence) {
      try {
        const resolved = await resolver.resolve(proposed.resource);
        if (!resolved)
          throw new ReflectionError(
            `Evidence does not resolve: ${proposed.resource}. Check the file and line range, then retry openwiki_reflect.`,
          );
        if (
          evidence.some(
            ({ resource }) => resource === resolved.evidence.resource,
          )
        ) {
          throw new ReflectionError(
            "Evidence resolves to a repeated resource. Include each resource once, then retry openwiki_reflect.",
          );
        }
        evidence.push(resolved.evidence);
      } catch (error) {
        if (error instanceof ReflectionError) throw error;
        if (error instanceof ClaimsError)
          throw new ReflectionError(
            `Cannot capture evidence ${proposed.resource}. Use a readable, contained repo:// resource permitted by .openwikiignore, with a valid line range.`,
          );
        throw error;
      }
    }
    const reflection: Reflection = {
      id: `reflection-${randomUUID()}`,
      finding: parsed.data.finding,
      evidence,
    };
    const serialized = serializeReflection(reflection);
    const directory = await this.directory(true);
    const file = `${reflection.id}.json`;
    const temporary = path.join(
      directory!,
      `.${reflection.id}.${randomUUID()}.tmp`,
    );
    let ownsTemporary = false;
    try {
      const handle = await open(temporary, "wx");
      ownsTemporary = true;
      try {
        await handle.writeFile(serialized, "utf8");
      } finally {
        await handle.close();
      }
      // Publishing a hard link is atomic and refuses to replace an existing UUID file.
      await link(temporary, path.join(directory!, file));
    } catch {
      throw new ReflectionError(
        "The reflection could not be saved without replacing an existing file. Check the reflection directory and retry openwiki_reflect; existing reflections were preserved.",
      );
    } finally {
      if (ownsTemporary) await rm(temporary, { force: true });
    }
    return { id: reflection.id, path: `${REFLECTIONS_DIRECTORY}/${file}` };
  }

  /**
   * Reads pending local records without requiring Git history or current evidence.
   *
   * Invalid files produce inventory feedback while valid neighboring reflections
   * remain available. Temporary publication files are never treated as findings.
   *
   * @param ids - Optional captured identities; later arrivals are excluded when supplied.
   * @returns Valid reflections and a bounded explanation of unreadable records.
   */
  async list(ids?: readonly string[]): Promise<ReflectionInventory> {
    const reflections: Reflection[] = [];
    if (ids?.length === 0) return { reflections };
    const selected = ids && new Set(ids.map((id) => `${id}.json`));
    const failures: string[] = [];
    let directory: string | null;
    let files: string[];
    try {
      directory = await this.directory(false);
      if (!directory) return { reflections };
      files = (await readdir(directory))
        .filter(
          (file) => file.endsWith(".json") && (!selected || selected.has(file)),
        )
        .sort();
    } catch {
      return {
        reflections,
        unavailable:
          "The local reflection directory could not be read safely. Check openwiki/.reflections and retry.",
      };
    }
    for (const file of files) {
      try {
        const id = file.slice(0, -".json".length);
        if (!REFLECTION_ID_PATTERN.test(id))
          throw new ReflectionError("Invalid reflection filename.");
        const absolute = path.join(directory, file);
        const metadata = await lstat(absolute);
        if (!metadata.isFile() || metadata.isSymbolicLink())
          throw new ReflectionError("Reflection must be a regular file.");
        const physical = await realpath(absolute);
        if (physical !== absolute)
          throw new ReflectionError(
            "Reflection path cannot traverse an alias.",
          );
        const reflection = ReflectionSchema.parse(
          JSON.parse(await readFile(physical, "utf8")) as unknown,
        );
        if (reflection.id !== id)
          throw new ReflectionError(
            "Reflection identity must match its filename.",
          );
        reflections.push(reflection);
      } catch {
        failures.push(file);
      }
    }
    return {
      reflections,
      ...(failures.length
        ? {
            unavailable: `Some pending reflection files could not be read or validated: ${failures.join(", ")}. Restore their valid records before consolidation.`,
          }
        : {}),
    };
  }

  /**
   * Removes a successfully processed record only while its immutable contents still match.
   *
   * @param reflection - Exact record that was evaluated during consolidation.
   */
  async remove(reflection: Reflection): Promise<void> {
    const expected = ReflectionSchema.parse(reflection);
    const inventory = await this.list([expected.id]);
    if (inventory.unavailable) throw new ReflectionError(inventory.unavailable);
    const current = inventory.reflections[0];
    if (!current) return;
    if (serializeReflection(current) !== serializeReflection(expected))
      throw new ReflectionError(
        "The reflection changed during consolidation. It remains pending; retry the update with its current contents.",
      );
    const directory = await this.directory(false);
    if (!directory) return;
    try {
      await rm(path.join(directory, `${expected.id}.json`), { force: true });
    } catch {
      throw new ReflectionError(
        "The processed reflection could not be deleted. It remains pending; retry the update to recognize and remove the duplicate.",
      );
    }
  }

  /**
   * Resolves the fixed storage directory without following wiki-owned symlinks.
   *
   * @param create - Whether missing directories should be created for a new reflection.
   * @returns Canonical directory, or null when absent during retrieval.
   */
  private async directory(create: boolean): Promise<string | null> {
    let current = await realpath(this.root);
    for (const segment of ["openwiki", ".reflections"]) {
      current = path.join(current, segment);
      if (create) {
        try {
          await mkdir(current);
        } catch (error) {
          if (!(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "EEXIST"
          ))
            throw new ReflectionError(
              "The reflection directory could not be created. Check repository permissions and retry.",
            );
        }
      }
      try {
        const metadata = await lstat(current);
        if (
          !metadata.isDirectory() ||
          metadata.isSymbolicLink() ||
          (await realpath(current)) !== current
        ) {
          throw new ReflectionError(
            "Reflection storage must use real directories below the repository; remove filesystem aliases before retrying.",
          );
        }
      } catch (error) {
        if (!create && isFileNotFoundError(error)) return null;
        throw error;
      }
    }
    return current;
  }
}
