import { randomUUID } from "node:crypto";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { OPENWIKI_VERSION } from "../../version.js";
import { HostIntegrationError } from "../core/errors.js";
import {
  getJsonMcpEntryStatus,
  installJsonMcpEntry,
  uninstallJsonMcpEntry,
} from "./config-json.js";
import {
  getCodexMcpBlockStatus,
  installCodexMcpBlock,
  uninstallCodexMcpBlock,
} from "./config-toml.js";
import {
  getOpencodeMcpEntryStatus,
  installOpencodeMcpEntry,
  uninstallOpencodeMcpEntry,
} from "./config-opencode.js";
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
  type SkillReceipt,
} from "./skill-bundle.js";
import { defaultMcpServerCommand } from "./registry.js";
import type {
  HostIntegrationStatus,
  HostMcpServerCommand,
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
   * @param options - Installation scope, root, and conflict policy.
   * @returns Installed paths, mutation status, and any retained backup.
   */
  async install(
    target: HostTarget,
    options: InstallOptions,
  ): Promise<InstallResult> {
    const context = await resolveInstallContext(
      target,
      options.scope,
      options.root,
    );
    const mcpServerCommand =
      options.mcpServerCommand ?? defaultMcpServerCommand(target.id);
    assertMcpServerCommand(mcpServerCommand);
    const canonical = await inventorySkill(this.bundleDirectory, false);
    const inspection = await inspectInstallation(
      context.skillDirectory,
      target.id,
    );
    if (inspection.status === "modified" && !options.force) {
      throw new HostIntegrationError(
        "conflict",
        `An unmanaged or modified skill already exists at ${context.skillDirectory}.`,
      );
    }

    const installedCommand = installedMcpServerCommand(
      target,
      inspection.receipt,
    );
    const replaceMcpServerCommand =
      inspection.status === "installed" ? installedCommand : undefined;
    const current =
      inspection.status === "installed" &&
      inspection.receipt?.version === OPENWIKI_VERSION &&
      sameMcpServerCommand(installedCommand, mcpServerCommand) &&
      sameFiles(inspection.receipt.files, canonical.files);
    if (current) {
      const configChanged = await installManagedConfig(
        context.mcpConfigKind,
        context.mcpConfig,
        mcpServerCommand,
        replaceMcpServerCommand,
      );
      return resultFor(target, context, configChanged);
    }

    await mkdir(path.dirname(context.skillDirectory), { recursive: true });
    await assertNoSymlinkComponents(context.root, context.skillDirectory);
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
      await writeReceipt(staging, target.id, copied.files, mcpServerCommand);
    } catch (error) {
      await this.operations.removeDirectory(staging).catch(() => undefined);
      throw error;
    }

    return this.commitInstall(
      target,
      context,
      staging,
      inspection.status !== "not-installed",
      Boolean(options.force),
      mcpServerCommand,
      replaceMcpServerCommand,
    );
  }

  /**
   * Removes one unmodified managed host integration transactionally.
   *
   * @param target - Registry entry for the target host.
   * @param options - Installation scope and root containing the integration.
   * @returns Removed paths, mutation status, and any retained cleanup backup.
   */
  async uninstall(
    target: HostTarget,
    options: UninstallOptions,
  ): Promise<InstallResult> {
    const context = await resolveInstallContext(
      target,
      options.scope,
      options.root,
    );
    const inspection = await inspectInstallation(
      context.skillDirectory,
      target.id,
    );
    if (inspection.status === "modified") {
      throw new HostIntegrationError(
        "conflict",
        `Refusing to remove a modified skill from ${context.skillDirectory}.`,
      );
    }
    const mcpServerCommand = installedMcpServerCommand(
      target,
      inspection.receipt,
    );
    const configStatus = await getManagedConfigStatus(
      context.mcpConfigKind,
      context.mcpConfig,
      mcpServerCommand,
    );
    if (configStatus === "modified") {
      throw new HostIntegrationError(
        "conflict",
        `Refusing to remove modified or unmanaged MCP config from ${context.mcpConfig}.`,
      );
    }

    const hasSkill = inspection.status === "installed";
    const hasConfig = configStatus === "installed";
    if (!hasSkill && !hasConfig) {
      return resultFor(target, context, false);
    }

    const configSnapshot = hasConfig
      ? await snapshotTextFile(context.mcpConfig)
      : undefined;
    let configChanged = false;
    const cleanupBackup = siblingPath(
      context.skillDirectory,
      "uninstall",
      this.createId(),
    );

    try {
      if (hasConfig) {
        configChanged = await uninstallManagedConfig(
          context.mcpConfigKind,
          context.mcpConfig,
          mcpServerCommand,
        );
      }
      if (hasSkill) {
        await this.operations.move(context.skillDirectory, cleanupBackup);
      }
    } catch (error) {
      if (configChanged && configSnapshot) {
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
    if (hasSkill) {
      try {
        await this.operations.removeDirectory(cleanupBackup);
      } catch {
        backupPath = cleanupBackup;
      }
    }
    if (!backupPath) {
      await removeEmptySkillParents(context.root, context.skillDirectory).catch(
        () => undefined,
      );
    }

    return resultFor(target, context, true, backupPath);
  }

  /**
   * Reports whether a host integration is absent, intact, or modified.
   *
   * @param target - Registry entry for the target host.
   * @param options - Installation scope and root to inspect.
   * @returns Current managed installation status.
   */
  async status(
    target: HostTarget,
    options: UninstallOptions,
  ): Promise<HostIntegrationStatus> {
    if (!target[options.scope]) return "unsupported";
    const context = await resolveInstallContext(
      target,
      options.scope,
      options.root,
    );
    const skill = await inspectInstallation(context.skillDirectory, target.id);
    const config = await getManagedConfigStatus(
      context.mcpConfigKind,
      context.mcpConfig,
      installedMcpServerCommand(target, skill.receipt),
    );
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
   * @param mcpServerCommand - Exact MCP server invocation to install.
   * @param replaceMcpServerCommand - Exact prior invocation that may be replaced.
   * @returns Committed installation result.
   */
  private async commitInstall(
    target: HostTarget,
    context: InstallContext,
    staging: string,
    hasPriorSkill: boolean,
    force: boolean,
    mcpServerCommand: HostMcpServerCommand,
    replaceMcpServerCommand: HostMcpServerCommand | undefined,
  ): Promise<InstallResult> {
    const configSnapshot = await snapshotTextFile(context.mcpConfig);
    let configChanged = false;
    let priorSkill: string | undefined;
    let priorSkillMoved = false;
    let committed = false;

    try {
      configChanged = await installManagedConfig(
        context.mcpConfigKind,
        context.mcpConfig,
        mcpServerCommand,
        replaceMcpServerCommand,
      );
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
 * @param options - Installation scope, root, and conflict policy.
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
 * @param options - Installation scope and root containing the integration.
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
 * @param options - Installation scope and root to inspect.
 * @returns Current managed installation status.
 */
export async function getHostIntegrationStatus(
  target: HostTarget,
  options: UninstallOptions,
): Promise<HostIntegrationStatus> {
  return defaultInstaller.status(target, options);
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
 * Installs the registry-selected MCP config representation.
 *
 * @param kind - Registry-selected config adapter.
 * @param filePath - Absolute host config path.
 * @param entry - Exact executable invocation to install.
 * @param replaceableEntry - Exact prior invocation that may be replaced.
 * @returns Whether config changed.
 */
async function installManagedConfig(
  kind: InstallContext["mcpConfigKind"],
  filePath: string,
  entry: HostMcpServerCommand,
  replaceableEntry?: HostMcpServerCommand,
): Promise<boolean> {
  switch (kind) {
    case "json":
      return installJsonMcpEntry(filePath, entry, replaceableEntry);
    case "codex-toml":
      return installCodexMcpBlock(filePath, entry, replaceableEntry);
    case "opencode-json":
      return installOpencodeMcpEntry(filePath, entry, replaceableEntry);
  }
}

/**
 * Removes the registry-selected exact MCP config representation.
 *
 * @param kind - Registry-selected config adapter.
 * @param filePath - Absolute host config path.
 * @param entry - Exact executable invocation owned by the installed skill.
 * @returns Whether config changed.
 */
async function uninstallManagedConfig(
  kind: InstallContext["mcpConfigKind"],
  filePath: string,
  entry: HostMcpServerCommand,
): Promise<boolean> {
  switch (kind) {
    case "json":
      return uninstallJsonMcpEntry(filePath, entry);
    case "codex-toml":
      return uninstallCodexMcpBlock(filePath, entry);
    case "opencode-json":
      return uninstallOpencodeMcpEntry(filePath, entry);
  }
}

/**
 * Reports the registry-selected MCP config representation state.
 *
 * @param kind - Registry-selected config adapter.
 * @param filePath - Absolute host config path.
 * @param entry - Exact executable invocation expected by the installed skill.
 * @returns Absent, intact, or modified managed config state.
 */
async function getManagedConfigStatus(
  kind: InstallContext["mcpConfigKind"],
  filePath: string,
  entry: HostMcpServerCommand,
): Promise<HostIntegrationStatus> {
  switch (kind) {
    case "json":
      return getJsonMcpEntryStatus(filePath, entry);
    case "codex-toml":
      return getCodexMcpBlockStatus(filePath, entry);
    case "opencode-json":
      return getOpencodeMcpEntryStatus(filePath, entry);
  }
}

/**
 * Resolves the command recorded by an installed skill receipt.
 *
 * @param target - Registry host owning the installation.
 * @param receipt - Intact receipt, when a managed skill is installed.
 * @returns Recorded command, or the legacy default command.
 */
function installedMcpServerCommand(
  target: HostTarget,
  receipt: SkillReceipt | undefined,
): HostMcpServerCommand {
  return receipt?.mcpServerCommand ?? defaultMcpServerCommand(target.id);
}

/**
 * Compares two exact MCP server invocations.
 *
 * @param left - First executable invocation.
 * @param right - Second executable invocation.
 * @returns Whether command and ordered arguments are identical.
 */
function sameMcpServerCommand(
  left: HostMcpServerCommand,
  right: HostMcpServerCommand,
): boolean {
  return (
    left.command === right.command &&
    left.args.length === right.args.length &&
    left.args.every((argument, index) => argument === right.args[index])
  );
}

/**
 * Rejects unusable executable overrides before any installer mutation.
 *
 * @param entry - Candidate MCP server invocation.
 */
function assertMcpServerCommand(entry: HostMcpServerCommand): void {
  if (
    typeof entry.command !== "string" ||
    !Array.isArray(entry.args) ||
    !entry.args.every((argument) => typeof argument === "string")
  ) {
    throw new HostIntegrationError(
      "invalid_input",
      "The MCP server command must contain a string executable and arguments.",
    );
  }
  if (entry.command.trim().length === 0) {
    throw new HostIntegrationError(
      "invalid_input",
      "The MCP server command must not be empty.",
    );
  }
}
