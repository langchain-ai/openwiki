import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPENWIKI_VERSION } from "../../version.js";
import { writeTextAtomic } from "./atomic-file.js";
import type {
  HostIntegrationStatus,
  HostMcpServerCommand,
  HostTargetId,
} from "./types.js";

const RECEIPT_FILE = ".openwiki-install.json";
const ALLOWED_BUNDLE_ROOTS = new Set(["SKILL.md", "agents", "references"]);

/**
 * Ownership receipt stored inside one installed skill directory.
 */
export interface SkillReceipt {
  /**
   * Package that owns the installed files.
   */
  package: "openwiki";

  /**
   * OpenWiki package version that produced the installation.
   */
  version: string;

  /**
   * Exact MCP server invocation for each host that owns the directory.
   *
   * Hosts such as Codex and IBM Bob read the same skill directory, so one
   * installed skill can have several owners.
   */
  owners: Partial<Record<HostTargetId, HostMcpServerCommand>>;

  /**
   * SHA-256 hashes keyed by installed relative path.
   */
  files: Record<string, string>;
}

/**
 * Deterministic inventory of one canonical or installed skill directory.
 */
export interface SkillInventory {
  /**
   * SHA-256 hashes keyed by portable relative file path.
   */
  files: Record<string, string>;
}

/**
 * Inspection result for one skill destination.
 */
export interface InstallationInspection {
  /**
   * Current ownership and integrity state.
   */
  status: HostIntegrationStatus;

  /**
   * Validated receipt for an intact managed installation, including one owned
   * only by other hosts sharing the directory.
   *
   * @default undefined - the destination is absent or modified.
   */
  receipt?: SkillReceipt;
}

/**
 * Resolves the canonical host skill from a source or built installer module.
 *
 * @param moduleUrl - Source or built installer module URL.
 * @returns Absolute canonical skill bundle path.
 */
export function resolveCanonicalSkillBundle(moduleUrl: string): string {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(moduleUrl)),
    "../../../",
  );
  return path.join(packageRoot, "integrations", "openwiki");
}

/**
 * Inventories and validates one canonical or installed skill directory.
 *
 * @param directory - Skill directory to inspect.
 * @param allowReceipt - Whether the managed receipt may exist at the root.
 * @returns Deterministic relative-path hash inventory.
 */
export async function inventorySkill(
  directory: string,
  allowReceipt: boolean,
): Promise<SkillInventory> {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("The OpenWiki skill bundle must be a real directory.");
  }

  const files: Record<string, string> = {};
  await walk(directory, "");
  if (!Object.hasOwn(files, "SKILL.md")) {
    throw new Error("The OpenWiki skill bundle is missing SKILL.md.");
  }
  return { files };

  /**
   * Recursively visits regular files below the skill root.
   *
   * @param current - Absolute directory currently being inspected.
   * @param relativeDirectory - Portable relative directory path.
   */
  async function walk(
    current: string,
    relativeDirectory: string,
  ): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const topLevel = relative.split("/", 1)[0];
      if (relative === RECEIPT_FILE && allowReceipt && !entry.isDirectory()) {
        continue;
      }
      if (!topLevel || !ALLOWED_BUNDLE_ROOTS.has(topLevel)) {
        throw new Error(`Unexpected OpenWiki skill path: ${relative}`);
      }
      if (topLevel === "SKILL.md" && relative !== "SKILL.md") {
        throw new Error(`Unexpected OpenWiki skill path: ${relative}`);
      }

      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `OpenWiki skill symlinks are not supported: ${relative}`,
        );
      }
      if (entry.isDirectory()) {
        if (relative === "SKILL.md") {
          throw new Error("SKILL.md must be a regular file.");
        }
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        if (relative === "agents" || relative === "references") {
          throw new Error(
            `OpenWiki skill path must be a directory: ${relative}`,
          );
        }
        files[relative] = createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex");
      } else {
        throw new Error(
          `OpenWiki skill special files are not supported: ${relative}`,
        );
      }
    }
  }
}

/**
 * Atomically writes a deterministic ownership receipt into a skill directory.
 *
 * A single owner keeps the original one-host receipt shape, so installations
 * that never share a directory are byte-for-byte unchanged.
 *
 * @param directory - Staged or installed skill directory.
 * @param owners - MCP server invocation for each host owning the destination.
 * @param files - Canonical file hashes present in the directory.
 * @param version - OpenWiki version that produced the files.
 */
export async function writeReceipt(
  directory: string,
  owners: Partial<Record<HostTargetId, HostMcpServerCommand>>,
  files: Record<string, string>,
  version: string = OPENWIKI_VERSION,
): Promise<void> {
  const entries = Object.entries(owners);
  const [onlyOwner] = entries;
  const receipt =
    entries.length === 1 && onlyOwner
      ? {
          package: "openwiki",
          version,
          target: onlyOwner[0],
          mcpServerCommand: onlyOwner[1],
          files,
        }
      : { package: "openwiki", version, owners, files };
  await writeTextAtomic(
    path.join(directory, RECEIPT_FILE),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

/**
 * Inspects ownership and exact content integrity for one destination.
 *
 * An intact directory owned only by other hosts reports `not-installed` for
 * this target while still returning its receipt, so the target can join it.
 *
 * @param directory - Host-owned skill destination.
 * @param target - Host whose ownership is being inspected.
 * @returns Absent, intact, or modified state and any valid receipt.
 */
export async function inspectInstallation(
  directory: string,
  target: HostTargetId,
): Promise<InstallationInspection> {
  try {
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      return { status: "modified" };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "not-installed" };
    }
    throw error;
  }

  try {
    const receipt = await readReceipt(directory);
    const inventory = await inventorySkill(directory, true);
    if (!sameFiles(receipt.files, inventory.files)) {
      return { status: "modified" };
    }
    return {
      status: Object.hasOwn(receipt.owners, target)
        ? "installed"
        : "not-installed",
      receipt,
    };
  } catch {
    return { status: "modified" };
  }
}

/**
 * Compares two deterministic file-hash maps.
 *
 * @param left - First inventory.
 * @param right - Second inventory.
 * @returns Whether both contain exactly the same paths and hashes.
 */
export function sameFiles(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([file, hash]) => right[file] === hash)
  );
}

/**
 * Reads and strictly validates one managed ownership receipt.
 *
 * @param directory - Installed skill directory.
 * @returns Validated ownership receipt.
 */
async function readReceipt(directory: string): Promise<SkillReceipt> {
  const parsed: unknown = JSON.parse(
    await readFile(path.join(directory, RECEIPT_FILE), "utf8"),
  );
  if (!isRecord(parsed)) throw new Error("Invalid skill receipt.");
  const owners = receiptOwners(parsed);
  if (
    !owners ||
    parsed.package !== "openwiki" ||
    typeof parsed.version !== "string" ||
    !parsed.version ||
    !isHashRecord(parsed.files)
  ) {
    throw new Error("Invalid skill receipt.");
  }
  return {
    package: "openwiki",
    version: parsed.version,
    owners,
    files: parsed.files,
  };
}

/**
 * Extracts the owning hosts from either strict receipt shape.
 *
 * @param value - Parsed receipt object.
 * @returns MCP server invocation per owning host, or `undefined` when invalid.
 */
function receiptOwners(
  value: Record<string, unknown>,
): SkillReceipt["owners"] | undefined {
  const keys = Object.keys(value).sort().join(",");
  if (keys === "files,mcpServerCommand,package,target,version") {
    return typeof value.target === "string" &&
      value.target &&
      isMcpServerCommand(value.mcpServerCommand)
      ? { [value.target]: value.mcpServerCommand }
      : undefined;
  }
  if (keys !== "files,owners,package,version" || !isRecord(value.owners)) {
    return undefined;
  }
  const entries = Object.entries(value.owners);
  return entries.length > 0 &&
    entries.every(([target, command]) => target && isMcpServerCommand(command))
    ? Object.fromEntries(entries)
    : undefined;
}

/**
 * Validates an exact MCP server invocation.
 *
 * @param value - Candidate receipt field.
 * @returns Whether the value contains only a command and ordered arguments.
 */
function isMcpServerCommand(value: unknown): value is HostMcpServerCommand {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).sort().join(",") === "args,command" &&
    typeof value.command === "string" &&
    value.command.trim().length > 0 &&
    Array.isArray(value.args) &&
    value.args.every((argument) => typeof argument === "string")
  );
}

/**
 * Narrows an unknown value to a valid portable path-to-hash map.
 *
 * @param value - Unknown receipt `files` field.
 * @returns Whether every key and SHA-256 value is valid.
 */
function isHashRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([relative, hash]) => {
    const normalized = relative.split("/").join(path.sep);
    return (
      relative !== RECEIPT_FILE &&
      !path.isAbsolute(relative) &&
      !relative.split("/").includes("..") &&
      resolvePortableRoot(relative) !== undefined &&
      path.normalize(normalized) === normalized &&
      typeof hash === "string" &&
      /^[a-f0-9]{64}$/u.test(hash)
    );
  });
}

/**
 * Resolves the allowed top-level bundle root for a portable receipt path.
 *
 * @param relative - Slash-delimited receipt path.
 * @returns Allowed root name, or `undefined` when disallowed.
 */
function resolvePortableRoot(relative: string): string | undefined {
  const root = relative.split("/", 1)[0];
  return root && ALLOWED_BUNDLE_ROOTS.has(root) ? root : undefined;
}

/**
 * Narrows an unknown value to a non-array object.
 *
 * @param value - Unknown parsed JSON value.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
