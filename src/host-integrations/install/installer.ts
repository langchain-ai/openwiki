import { randomUUID } from "node:crypto";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { OPENWIKI_VERSION } from "../../version.js";
import { HostIntegrationError } from "../core/errors.js";
import {
  getJsonMcpEntryStatus,
  installJsonMcpEntry,
  uninstallJsonMcpEntry,
  type JsonMcpEntry,
} from "./config-json.js";
import {
  getCodexMcpBlockStatus,
  installCodexMcpBlock,
  uninstallCodexMcpBlock,
} from "./config-toml.js";
import {
  assertNoSymlinkComponents,
  forcedBackupPath,
  removeEmptySkillParents,
  resolveInstallContext,
  restoreTextFile,
  resultFor,
  siblingPath,
  snapshotTextFile,
  type InstallContext,
  type TextFileSnapshot,
} from "./install-paths.js";
import {
  inspectInstallation,
  inventorySkill,
  resolveCanonicalSkillBundle as resolveSkillBundle,
  sameFiles,
  writeReceipt,
} from "./skill-bundle.js";
import type {
  HostIntegrationStatus,
  HostTarget,
  InstallOptions,
  InstallResult,
  UninstallOptions,
} from "./types.js";

/**
 * Injectable file operations used by transaction-failure tests.
 */
export interface HostIntegrationInstallerOperations {
  /**
   * Atomically moves one filesystem entry.
   *
   * @param source - Existing source path.
   * @param destination - Non-existing destination path.
   */
  move(source: string, destination: string): Promise<void>;

  /**
   * Recursively removes one private staging or backup directory.
   *
   * @param directory - Directory owned by the active installer transaction.
   */
  removeDirectory(directory: string): Promise<void>;
}

/**
 * Optional deterministic inputs for one installer service.
 */
export interface HostIntegrationInstallerOptions {
  /**
   * File operations used for commit and cleanup steps.
   *
   * @default Node.js rename and recursive removal.
   */
  operations?: HostIntegrationInstallerOperations;

  /**
   * Clock used to name retained forced backups.
   *
   * @default () => new Date()
   */
  now?: () => Date;

  /**
   * Unique identifier source for private sibling paths.
   *
   * @default randomUUID
   */
  createId?: () => string;

  /**
   * Module URL used to resolve the source or built package root.
   *
   * @default import.meta.url
   */
  moduleUrl?: string;
}

const DEFAULT_OPERATIONS: HostIntegrationInstallerOperations = {
  move: rename,
  removeDirectory: async (directory) => {
    await rm(directory, { force: true, recursive: true });
  },
};

/**
 * Transactional installer service with injectable commit operations.
 */
export class HostIntegrationInstaller {
  /**
   * File operations used for atomic moves and private-directory cleanup.
   */
  private readonly operations: HostIntegrationInstallerOperations;

  /**
   * Clock used for human-recognizable forced backup names.
   */
  private readonly now: () => Date;

  /**
   * Unique identifier source used for collision-resistant sibling paths.
   */
  private readonly createId: () => string;

  /**
   * Canonical package-owned skill bundle.
   */
  private readonly bundleDirectory: string;

  /**
   * Creates an installer service.
   *
   * @param options - Optional deterministic file operations and path inputs.
   */
  constructor(options: HostIntegrationInstallerOptions = {}) {
    this.operations = options.operations ?? DEFAULT_OPERATIONS;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.bundleDirectory = resolveSkillBundle(
      options.moduleUrl ?? import.meta.url,
    );
  }

  /**
   * Installs or upgrades one host integration transactionally.
   *
   * @param target - Registry entry for the target host.
   * @param options - Project root and conflict policy.
   * @returns Installed paths, mutation status, and any retained backup.
   */
  async install(
    target: HostTarget,
    options: InstallOptions,
  ): Promise<InstallResult> {
    const context = await resolveInstallContext(target, options.projectRoot);
    const canonical = await inventorySkill(this.bundleDirectory, false);
    await mkdir(path.dirname(context.skillDirectory), { recursive: true });
    await assertNoSymlinkComponents(
      context.projectRoot,
      context.skillDirectory,
    );

    const staging = siblingPath(
      context.skillDirectory,
      "staging",
      this.createId(),
    );
    await cp(this.bundleDirectory, staging, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });

    try {
      const copied = await inventorySkill(staging, false);
      if (!sameFiles(canonical.files, copied.files)) {
        throw new HostIntegrationError(
          "invalid_state",
          "The staged OpenWiki skill does not match the canonical bundle.",
        );
      }
      await writeReceipt(staging, target.id, copied.files);
    } catch (error) {
      await this.operations.removeDirectory(staging).catch(() => undefined);
      throw error;
    }

    const inspection = await inspectInstallation(
      context.skillDirectory,
      target.id,
    );
    if (inspection.status === "modified" && !options.force) {
      await this.operations.removeDirectory(staging);
      throw new HostIntegrationError(
        "conflict",
        `An unmanaged or modified skill already exists at ${context.skillDirectory}.`,
      );
    }

    const current =
      inspection.status === "installed" &&
      inspection.receipt?.version === OPENWIKI_VERSION &&
      sameFiles(inspection.receipt.files, canonical.files);
    if (current) {
      await this.operations.removeDirectory(staging);
      const configChanged = await installManagedConfig(
        target,
        context.mcpConfig,
      );
      return resultFor(target, context, configChanged);
    }

    return this.commitInstall(
      target,
      context,
      staging,
      inspection.status !== "not-installed",
      Boolean(options.force),
    );
  }

  /**
   * Removes one unmodified managed host integration transactionally.
   *
   * @param target - Registry entry for the target host.
   * @param options - Project root containing the managed integration.
   * @returns Removed paths, mutation status, and any retained cleanup backup.
   */
  async uninstall(
    target: HostTarget,
    options: UninstallOptions,
  ): Promise<InstallResult> {
    const context = await resolveInstallContext(target, options.projectRoot);
    const inspection = await inspectInstallation(
      context.skillDirectory,
      target.id,
    );
    if (inspection.status === "not-installed") {
      return resultFor(target, context, false);
    }
    if (inspection.status === "modified") {
      throw new HostIntegrationError(
        "conflict",
        `Refusing to remove a modified skill from ${context.skillDirectory}.`,
      );
    }

    const configSnapshot = await snapshotTextFile(context.mcpConfig);
    let configChanged = false;
    const cleanupBackup = siblingPath(
      context.skillDirectory,
      "uninstall",
      this.createId(),
    );

    try {
      configChanged = await uninstallManagedConfig(target, context.mcpConfig);
      await this.operations.move(context.skillDirectory, cleanupBackup);
    } catch (error) {
      if (configChanged) {
        try {
          await restoreTextFile(context.mcpConfig, configSnapshot);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Host integration uninstall failed and config rollback was incomplete.",
            { cause: rollbackError },
          );
        }
      }
      throw error;
    }

    let backupPath: string | undefined;
    try {
      await this.operations.removeDirectory(cleanupBackup);
    } catch {
      backupPath = cleanupBackup;
    }
    if (!backupPath) {
      await removeEmptySkillParents(
        context.projectRoot,
        context.skillDirectory,
      ).catch(() => undefined);
    }

    return resultFor(target, context, true, backupPath);
  }

  /**
   * Reports whether a host integration is absent, intact, or modified.
   *
   * @param target - Registry entry for the target host.
   * @param projectRoot - Project root to inspect.
   * @returns Current managed installation status.
   */
  async status(
    target: HostTarget,
    projectRoot: string,
  ): Promise<HostIntegrationStatus> {
    const context = await resolveInstallContext(target, projectRoot);
    const [skill, config] = await Promise.all([
      inspectInstallation(context.skillDirectory, target.id),
      getManagedConfigStatus(target, context.mcpConfig),
    ]);
    if (skill.status === "not-installed" && config === "not-installed") {
      return "not-installed";
    }
    return skill.status === "installed" && config === "installed"
      ? "installed"
      : "modified";
  }

  /**
   * Mutates config and atomically commits a non-idempotent skill install.
   *
   * @param target - Registry target receiving the integration.
   * @param context - Canonical transaction paths.
   * @param staging - Fully inventoried staged skill directory.
   * @param hasPriorSkill - Whether a destination must be moved aside.
   * @param force - Whether the prior skill must be retained as a backup.
   * @returns Committed installation result.
   */
  private async commitInstall(
    target: HostTarget,
    context: InstallContext,
    staging: string,
    hasPriorSkill: boolean,
    force: boolean,
  ): Promise<InstallResult> {
    const configSnapshot = await snapshotTextFile(context.mcpConfig);
    let configChanged = false;
    let priorSkill: string | undefined;
    let priorSkillMoved = false;
    let committed = false;

    try {
      configChanged = await installManagedConfig(target, context.mcpConfig);
      if (hasPriorSkill) {
        priorSkill = force
          ? forcedBackupPath(
              context.skillDirectory,
              this.now(),
              this.createId(),
            )
          : siblingPath(context.skillDirectory, "rollback", this.createId());
        await this.operations.move(context.skillDirectory, priorSkill);
        priorSkillMoved = true;
      }

      await this.operations.move(staging, context.skillDirectory);
      committed = true;
    } catch (error) {
      if (!committed) {
        await this.rollbackInstall(
          context,
          staging,
          priorSkillMoved ? priorSkill : undefined,
          configChanged ? configSnapshot : undefined,
          error,
        );
      }
      throw error;
    }

    const backupPath = await this.cleanupPriorSkill(
      priorSkillMoved ? priorSkill : undefined,
      force,
    );
    return resultFor(target, context, true, backupPath);
  }

  /**
   * Removes an unmodified rollback directory or retains a forced backup.
   *
   * @param priorSkill - Prior skill moved aside during commit.
   * @param force - Whether the prior skill must be retained.
   * @returns Retained backup path, when one remains.
   */
  private async cleanupPriorSkill(
    priorSkill: string | undefined,
    force: boolean,
  ): Promise<string | undefined> {
    if (!priorSkill) return undefined;
    if (force) return priorSkill;
    try {
      await this.operations.removeDirectory(priorSkill);
      return undefined;
    } catch {
      return priorSkill;
    }
  }

  /**
   * Restores config and prior skill state after an install commit fails.
   *
   * @param context - Resolved transaction paths.
   * @param staging - Private staged skill directory.
   * @param priorSkill - Prior skill moved aside before the failure.
   * @param configSnapshot - Config snapshot when the adapter changed it.
   * @param originalError - Failure that initiated rollback.
   */
  private async rollbackInstall(
    context: InstallContext,
    staging: string,
    priorSkill: string | undefined,
    configSnapshot: TextFileSnapshot | undefined,
    originalError: unknown,
  ): Promise<void> {
    const rollbackErrors: unknown[] = [];
    if (priorSkill) {
      try {
        await this.operations.move(priorSkill, context.skillDirectory);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (configSnapshot) {
      try {
        await restoreTextFile(context.mcpConfig, configSnapshot);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    try {
      await this.operations.removeDirectory(staging);
    } catch (error) {
      rollbackErrors.push(error);
    }

    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [originalError, ...rollbackErrors],
        "Host integration installation failed and rollback was incomplete.",
      );
    }
  }
}

const defaultInstaller = new HostIntegrationInstaller();

/**
 * Installs or upgrades one host integration transactionally.
 *
 * @param target - Registry entry for the target host.
 * @param options - Project root and conflict policy.
 * @returns Installed paths, mutation status, and any retained backup.
 */
export async function installHostIntegration(
  target: HostTarget,
  options: InstallOptions,
): Promise<InstallResult> {
  return defaultInstaller.install(target, options);
}

/**
 * Removes one unmodified managed host integration transactionally.
 *
 * @param target - Registry entry for the target host.
 * @param options - Project root containing the managed integration.
 * @returns Removed paths, mutation status, and any retained cleanup backup.
 */
export async function uninstallHostIntegration(
  target: HostTarget,
  options: UninstallOptions,
): Promise<InstallResult> {
  return defaultInstaller.uninstall(target, options);
}

/**
 * Reports whether a host integration is absent, intact, or modified.
 *
 * @param target - Registry entry for the target host.
 * @param projectRoot - Project root to inspect.
 * @returns Current managed installation status.
 */
export async function getHostIntegrationStatus(
  target: HostTarget,
  projectRoot: string,
): Promise<HostIntegrationStatus> {
  return defaultInstaller.status(target, projectRoot);
}

/**
 * Resolves the canonical host skill from a source or built installer module.
 *
 * @param moduleUrl - Source or built installer module URL.
 * @returns Absolute canonical skill bundle path.
 */
export function resolveCanonicalSkillBundle(
  moduleUrl = import.meta.url,
): string {
  return resolveSkillBundle(moduleUrl);
}

/**
 * Creates the exact managed JSON command for one host.
 *
 * @param target - Registry target receiving the MCP entry.
 * @returns Managed command and ordered arguments.
 */
function jsonEntry(target: HostTarget): JsonMcpEntry {
  return {
    command: "openwiki",
    args: ["mcp", "--host", target.id],
  };
}

/**
 * Installs the registry-selected MCP config representation.
 *
 * @param target - Registry target selecting the adapter.
 * @param filePath - Absolute host config path.
 * @returns Whether config changed.
 */
async function installManagedConfig(
  target: HostTarget,
  filePath: string,
): Promise<boolean> {
  return target.mcpConfig.kind === "json"
    ? installJsonMcpEntry(filePath, jsonEntry(target))
    : installCodexMcpBlock(filePath, target.id);
}

/**
 * Removes the registry-selected exact MCP config representation.
 *
 * @param target - Registry target selecting the adapter.
 * @param filePath - Absolute host config path.
 * @returns Whether config changed.
 */
async function uninstallManagedConfig(
  target: HostTarget,
  filePath: string,
): Promise<boolean> {
  return target.mcpConfig.kind === "json"
    ? uninstallJsonMcpEntry(filePath, jsonEntry(target))
    : uninstallCodexMcpBlock(filePath, target.id);
}

/**
 * Reports the registry-selected MCP config representation state.
 *
 * @param target - Registry target selecting the adapter.
 * @param filePath - Absolute host config path.
 * @returns Absent, intact, or modified managed config state.
 */
async function getManagedConfigStatus(
  target: HostTarget,
  filePath: string,
): Promise<HostIntegrationStatus> {
  return target.mcpConfig.kind === "json"
    ? getJsonMcpEntryStatus(filePath, jsonEntry(target))
    : getCodexMcpBlockStatus(filePath, target.id);
}
