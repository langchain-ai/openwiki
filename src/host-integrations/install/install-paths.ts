import {
  lstat,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import { HostIntegrationError } from "../core/errors.js";
import { writeTextAtomic } from "./atomic-file.js";
import type { HostTarget, InstallResult } from "./types.js";

const PROTECTED_HOST_DIRECTORIES = [
  ".agents",
  ".codex",
  ".claude",
  ".deepagents",
];

/**
 * Exact pre-mutation state of one optional UTF-8 config file.
 */
export interface TextFileSnapshot {
  /**
   * Whether the config existed before mutation.
   */
  existed: boolean;

  /**
   * Exact prior UTF-8 bytes when the config existed.
   *
   * @default undefined - the config did not exist.
   */
  content?: string;
}

/**
 * Resolved canonical paths for one host transaction.
 */
export interface InstallContext {
  /**
   * Canonical real project root.
   */
  projectRoot: string;

  /**
   * Absolute host-owned skill directory.
   */
  skillDirectory: string;

  /**
   * Absolute host-owned MCP config path.
   */
  mcpConfig: string;
}

/**
 * Resolves canonical transaction paths and rejects symlinked components.
 *
 * @param target - Registry entry supplying project-relative destinations.
 * @param candidateRoot - User-supplied project root.
 * @returns Canonical project, skill, and config paths.
 */
export async function resolveInstallContext(
  target: HostTarget,
  candidateRoot: string,
): Promise<InstallContext> {
  const projectRoot = await resolveProjectRoot(candidateRoot);
  const skillDirectory = resolveInside(
    projectRoot,
    target.skillDirectory,
    "skill directory",
  );
  const mcpConfig = resolveInside(
    projectRoot,
    target.mcpConfig.relativePath,
    "MCP config",
  );
  await assertNoSymlinkComponents(projectRoot, skillDirectory);
  await assertNoSymlinkComponents(projectRoot, mcpConfig);
  return { projectRoot, skillDirectory, mcpConfig };
}

/**
 * Rejects symbolic links in every existing destination component.
 *
 * @param projectRoot - Canonical project root.
 * @param destination - Contained absolute destination path.
 */
export async function assertNoSymlinkComponents(
  projectRoot: string,
  destination: string,
): Promise<void> {
  const parts = path.relative(projectRoot, destination).split(path.sep);
  let current = projectRoot;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new HostIntegrationError(
          "invalid_input",
          "Host integration destinations must not contain symbolic links.",
        );
      }
      if (index < parts.length - 1 && !entry.isDirectory()) {
        throw new HostIntegrationError(
          "invalid_input",
          "A host integration destination parent is not a directory.",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

/**
 * Snapshots an optional UTF-8 config before a transaction.
 *
 * @param filePath - Absolute config path.
 * @returns Exact content or an absence marker.
 */
export async function snapshotTextFile(
  filePath: string,
): Promise<TextFileSnapshot> {
  try {
    return { existed: true, content: await readFile(filePath, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { existed: false };
    }
    throw error;
  }
}

/**
 * Restores an exact config snapshot after a pre-commit failure.
 *
 * @param filePath - Absolute config path.
 * @param snapshot - Pre-mutation bytes or absence marker.
 */
export async function restoreTextFile(
  filePath: string,
  snapshot: TextFileSnapshot,
): Promise<void> {
  if (snapshot.existed) {
    await writeTextAtomic(filePath, snapshot.content ?? "");
  } else {
    await rm(filePath, { force: true });
  }
}

/**
 * Produces one private sibling transaction path.
 *
 * @param destination - Managed skill destination.
 * @param purpose - Transaction path purpose.
 * @param id - Collision-resistant identifier.
 * @returns Absolute private sibling path.
 */
export function siblingPath(
  destination: string,
  purpose: "rollback" | "staging" | "uninstall",
  id: string,
): string {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.openwiki-${purpose}-${id}`,
  );
}

/**
 * Produces one retained, timestamped forced-replacement backup path.
 *
 * @param destination - Managed skill destination.
 * @param now - Backup timestamp.
 * @param id - Collision-resistant identifier.
 * @returns Absolute retained sibling backup path.
 */
export function forcedBackupPath(
  destination: string,
  now: Date,
  id: string,
): string {
  const timestamp = now.toISOString().replace(/[:.]/gu, "-");
  return path.join(
    path.dirname(destination),
    `${path.basename(destination)}.openwiki-backup-${timestamp}-${id}`,
  );
}

/**
 * Removes empty skill ancestors without deleting host-owned root directories.
 *
 * @param projectRoot - Canonical project root.
 * @param skillDirectory - Removed managed skill path.
 */
export async function removeEmptySkillParents(
  projectRoot: string,
  skillDirectory: string,
): Promise<void> {
  const protectedPaths = new Set(
    PROTECTED_HOST_DIRECTORIES.map((directory) =>
      path.join(projectRoot, directory),
    ),
  );
  let current = path.dirname(skillDirectory);
  while (
    current !== projectRoot &&
    current.startsWith(`${projectRoot}${path.sep}`) &&
    !protectedPaths.has(current)
  ) {
    if ((await readdir(current)).length > 0) return;
    await rmdir(current);
    current = path.dirname(current);
  }
}

/**
 * Creates one stable public result object.
 *
 * @param target - Affected registry target.
 * @param context - Canonical project paths.
 * @param changed - Whether managed state changed.
 * @param backupPath - Optional retained sibling backup.
 * @returns Public installation result.
 */
export function resultFor(
  target: HostTarget,
  context: InstallContext,
  changed: boolean,
  backupPath?: string,
): InstallResult {
  return {
    target: target.id,
    skillDirectory: context.skillDirectory,
    mcpConfig: context.mcpConfig,
    changed,
    ...(backupPath ? { backupPath } : {}),
  };
}

/**
 * Resolves and validates one existing project directory.
 *
 * @param candidate - User-supplied project root.
 * @returns Canonical absolute directory path.
 */
async function resolveProjectRoot(candidate: string): Promise<string> {
  try {
    const root = await realpath(candidate);
    if (!(await lstat(root)).isDirectory()) {
      throw new HostIntegrationError(
        "invalid_input",
        "The integration project root must be a directory.",
      );
    }
    return root;
  } catch (error) {
    if (error instanceof HostIntegrationError) throw error;
    throw new HostIntegrationError(
      "invalid_input",
      "The integration project root must be an existing directory.",
    );
  }
}

/**
 * Resolves a trusted registry path while enforcing project containment.
 *
 * @param projectRoot - Canonical project root.
 * @param relativePath - Registry-owned relative destination.
 * @param label - Destination label used in safe validation errors.
 * @returns Absolute contained destination path.
 */
function resolveInside(
  projectRoot: string,
  relativePath: string,
  label: string,
): string {
  if (path.isAbsolute(relativePath)) {
    throw new HostIntegrationError(
      "invalid_input",
      `The host ${label} must be project-relative.`,
    );
  }
  const resolved = path.resolve(projectRoot, relativePath);
  if (
    resolved === projectRoot ||
    !resolved.startsWith(`${projectRoot}${path.sep}`)
  ) {
    throw new HostIntegrationError(
      "invalid_input",
      `The host ${label} must stay inside the project root.`,
    );
  }
  return resolved;
}
