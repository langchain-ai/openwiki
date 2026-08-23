import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  HostIntegrationInstaller,
  resolveCanonicalSkillBundle,
  type HostIntegrationInstallerOperations,
} from "../../src/integrations/install/installer.ts";
import { removeEmptySkillParents } from "../../src/integrations/install/install-paths.ts";
import {
  defaultMcpServerCommand,
  getHostTarget,
  HOST_TARGETS,
  listHostTargets,
} from "../../src/integrations/install/registry.ts";
import type {
  HostIntegrationScope,
  HostTarget,
  InstallOptions,
} from "../../src/integrations/install/types.ts";
import { OPENWIKI_VERSION } from "../../src/version.ts";

const RECEIPT_FILE = ".openwiki-install.json";
const CONFIG_SENTINEL = "UNRELATED_CONFIG_SENTINEL";
const TARGETS = listHostTargets();
const temporaryRoots: string[] = [];

/**
 * Creates one isolated project root for an installer test.
 *
 * @returns Absolute temporary project path.
 */
async function createProject(): Promise<string> {
  const root = await createDirectory();
  execFileSync("git", ["init", "--quiet", root]);
  return root;
}

/**
 * Creates one isolated directory without initializing a Git repository.
 *
 * @returns Absolute temporary directory path.
 */
async function createDirectory(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "openwiki-installer-")),
  );
  temporaryRoots.push(root);
  return root;
}

/**
 * Resolves a target's absolute skill path below a test project.
 *
 * @param root - Test project root.
 * @param target - Registry target.
 * @returns Absolute skill destination.
 */
function skillPath(
  root: string,
  target: HostTarget,
  scope: HostIntegrationScope = "project",
): string {
  const destinations = target[scope];
  if (!destinations) throw new Error(`${target.id} does not support ${scope}.`);
  return path.join(root, destinations.skillDirectory);
}

/**
 * Resolves a target's absolute MCP config path below a test project.
 *
 * @param root - Test project root.
 * @param target - Registry target.
 * @returns Absolute config destination.
 */
function configPath(
  root: string,
  target: HostTarget,
  scope: HostIntegrationScope = "project",
): string {
  const destinations = target[scope];
  if (!destinations) throw new Error(`${target.id} does not support ${scope}.`);
  return path.join(root, destinations.mcpConfig.relativePath);
}

/**
 * Builds project-scoped installer options for a disposable root.
 *
 * @param root - Temporary project root.
 * @returns Project-scoped installation options.
 */
function projectOptions(root: string): InstallOptions {
  return { scope: "project", root };
}

/**
 * Builds user-scoped installer options for a disposable fake home.
 *
 * @param root - Temporary fake home directory.
 * @returns User-scoped installation options.
 */
function userOptions(root: string): InstallOptions {
  return { scope: "user", root };
}

/**
 * Writes unrelated host config that an install must preserve.
 *
 * @param root - Test project root.
 * @param target - Registry target.
 */
async function seedConfig(root: string, target: HostTarget): Promise<void> {
  const destination = configPath(root, target);
  await mkdir(path.dirname(destination), { recursive: true });
  const kind = target.project.mcpConfig.kind;
  const content =
    kind === "json"
      ? `${JSON.stringify({
          note: CONFIG_SENTINEL,
          mcpServers: { other: { command: "other" } },
        })}\n`
      : kind === "opencode-json"
        ? [
            "{",
            `  // ${CONFIG_SENTINEL}`,
            '  "mcp": { "other": { "type": "remote", "url": "https://example.com" } }',
            "}",
            "",
          ].join("\n")
        : `model = "${CONFIG_SENTINEL}"\n\n`;
  await writeFile(destination, content, { encoding: "utf8", mode: 0o600 });
  await chmod(destination, 0o600);
}

/**
 * Asserts that host config retains unrelated state and the exact host argument.
 *
 * @param root - Test project root.
 * @param target - Registry target.
 */
async function expectManagedConfig(
  root: string,
  target: HostTarget,
): Promise<void> {
  const content = await readFile(configPath(root, target), "utf8");
  expect(content).toContain(CONFIG_SENTINEL);
  const kind = target.project.mcpConfig.kind;
  if (kind === "json") {
    expect(JSON.parse(content)).toMatchObject({
      mcpServers: {
        other: { command: "other" },
        openwiki: {
          command: "openwiki",
          args: ["mcp", "--host", target.id],
        },
      },
    });
  } else if (kind === "opencode-json") {
    const parsed: unknown = JSON.parse(content.replace(/^\s*\/\/.*$/gmu, ""));
    expect(parsed).toMatchObject({
      mcp: {
        other: { type: "remote", url: "https://example.com" },
        openwiki: {
          type: "local",
          command: ["openwiki", "mcp", "--host", target.id],
          enabled: true,
        },
      },
    });
  } else {
    expect(content).toContain('[mcp_servers.openwiki]\ncommand = "openwiki"');
    expect(content).toContain(`args = ["mcp", "--host", "${target.id}"]`);
  }
}

/**
 * Recursively reads regular files as UTF-8 strings for byte comparisons.
 *
 * @param directory - Directory to inventory.
 * @returns Portable relative paths mapped to exact file content.
 */
async function readTree(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  await walk(directory, "");
  return files;

  /**
   * Visits one directory in deterministic name order.
   *
   * @param current - Absolute current directory.
   * @param relativeDirectory - Portable relative directory.
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
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else {
        files[relative] = await readFile(absolute, "utf8");
      }
    }
  }
}

/**
 * Updates only the receipt version to simulate an intact older installation.
 *
 * @param directory - Installed skill directory.
 */
async function markReceiptOld(directory: string): Promise<void> {
  const receiptPath = path.join(directory, RECEIPT_FILE);
  const receipt: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
  if (!isRecord(receipt)) throw new Error("Expected a receipt object.");
  receipt.version = "0.0.0-test";
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
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

/**
 * Builds real file operations that fail one staged commit move.
 *
 * @returns Injected operations for pre-commit rollback tests.
 */
function failingCommitOperations(): HostIntegrationInstallerOperations {
  let failed = false;
  return {
    move: async (source, destination) => {
      if (!failed && source.includes(".openwiki-staging-")) {
        failed = true;
        throw new Error("INJECTED_COMMIT_FAILURE");
      }
      await rename(source, destination);
    },
    removeDirectory: async (directory) => {
      await rm(directory, { force: true, recursive: true });
    },
  };
}

/**
 * Builds real file operations that fail before an existing skill is moved.
 *
 * @param destination - Existing managed or unmanaged skill path.
 * @returns Injected operations for early rollback tests.
 */
function failingPriorMoveOperations(
  destination: string,
): HostIntegrationInstallerOperations {
  let failed = false;
  return {
    move: async (source, target) => {
      if (!failed && source === destination) {
        failed = true;
        throw new Error("INJECTED_PRIOR_MOVE_FAILURE");
      }
      await rename(source, target);
    },
    removeDirectory: async (directory) => {
      await rm(directory, { force: true, recursive: true });
    },
  };
}

/**
 * Builds real file operations that retain one post-commit backup.
 *
 * @param purpose - Backup purpose whose cleanup should fail.
 * @returns Injected operations for cleanup tests.
 */
function failingCleanupOperations(
  purpose: "rollback" | "uninstall",
): HostIntegrationInstallerOperations {
  return {
    move: rename,
    removeDirectory: async (directory) => {
      if (directory.includes(`.openwiki-${purpose}-`)) {
        throw new Error("INJECTED_CLEANUP_FAILURE");
      }
      await rm(directory, { force: true, recursive: true });
    },
  };
}

/**
 * Writes a host-specific malformed config fixture.
 *
 * @param root - Test project root.
 * @param target - Registry target.
 * @returns Exact malformed bytes written.
 */
async function writeMalformedConfig(
  root: string,
  target: HostTarget,
): Promise<string> {
  const destination = configPath(root, target);
  const content =
    target.project.mcpConfig.kind === "json"
      ? "{ malformed json\n"
      : target.project.mcpConfig.kind === "opencode-json"
        ? "{ malformed jsonc\n"
        : "# OPENWIKI:MCP:START\n";
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
  return content;
}

/**
 * Modifies the installed host config without changing the skill receipt.
 *
 * @param root - Test project root.
 * @param target - Registry target.
 */
async function modifyManagedConfig(
  root: string,
  target: HostTarget,
): Promise<void> {
  const destination = configPath(root, target);
  const content = await readFile(destination, "utf8");
  const kind = target.project.mcpConfig.kind;
  if (kind === "json") {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
      throw new Error("Expected an MCP server mapping.");
    }
    parsed.mcpServers.openwiki = { command: "custom", args: [] };
    await writeFile(
      destination,
      `${JSON.stringify(parsed, null, 2)}\n`,
      "utf8",
    );
  } else if (kind === "opencode-json") {
    await writeFile(
      destination,
      content.replace('"type": "local"', '"type": "custom"'),
      "utf8",
    );
  } else {
    await writeFile(
      destination,
      content.replace('command = "openwiki"', 'command = "custom"'),
      "utf8",
    );
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("host integration registry", () => {
  test("defines user and project destinations for all supported hosts", () => {
    expect(HOST_TARGETS).toMatchObject({
      codex: {
        producerActor: "codex",
        user: {
          skillDirectory: ".agents/skills/openwiki",
          mcpConfig: {
            kind: "codex-toml",
            relativePath: ".codex/config.toml",
          },
        },
        project: {
          skillDirectory: ".agents/skills/openwiki",
          mcpConfig: {
            kind: "codex-toml",
            relativePath: ".codex/config.toml",
          },
        },
      },
      claude: {
        producerActor: "claude-code",
        user: {
          skillDirectory: ".claude/skills/openwiki",
          mcpConfig: { kind: "json", relativePath: ".claude.json" },
        },
        project: {
          skillDirectory: ".claude/skills/openwiki",
          mcpConfig: { kind: "json", relativePath: ".mcp.json" },
        },
      },
      opencode: {
        producerActor: "opencode",
        user: {
          skillDirectory: ".config/opencode/skills/openwiki",
          mcpConfig: {
            kind: "opencode-json",
            relativePath: ".config/opencode/opencode.jsonc",
          },
        },
        project: {
          skillDirectory: ".opencode/skills/openwiki",
          mcpConfig: {
            kind: "opencode-json",
            relativePath: "opencode.jsonc",
          },
        },
      },
    });
    expect(getHostTarget("codex")).toBe(HOST_TARGETS.codex);
    expect(getHostTarget("unsupported")).toBeUndefined();
    expect(TARGETS.map((target) => target.id)).toEqual([
      "codex",
      "claude",
      "opencode",
    ]);
    const userTargets = TARGETS.filter((target) => target.user !== null);
    expect(
      new Set(userTargets.map((target) => target.user?.skillDirectory)).size,
    ).toBe(userTargets.length);
  });
});

describe.each(TARGETS)("$displayName host integration", (target) => {
  test("rejects an empty MCP executable before writing files", async () => {
    const root = await createProject();
    const installer = new HostIntegrationInstaller();

    await expect(
      installer.install(target, {
        ...projectOptions(root),
        mcpServerCommand: { command: "   ", args: [] },
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "The MCP server command must not be empty.",
    });
    await expect(access(skillPath(root, target))).rejects.toThrow();
    await expect(access(configPath(root, target))).rejects.toThrow();
  });

  test("treats a whitespace-only executable in the receipt as modified", async () => {
    const root = await createProject();
    const options = projectOptions(root);
    const installer = new HostIntegrationInstaller();
    await installer.install(target, options);

    const receiptPath = path.join(skillPath(root, target), RECEIPT_FILE);
    const receipt: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
    if (!isRecord(receipt) || !isRecord(receipt.mcpServerCommand)) {
      throw new Error("Expected a receipt command object.");
    }
    receipt.mcpServerCommand.command = "   ";
    await writeFile(
      receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );

    await expect(installer.status(target, options)).resolves.toBe("modified");
    await expect(installer.uninstall(target, options)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(access(skillPath(root, target))).resolves.toBeUndefined();
  });

  test("supports user scope", async () => {
    const fakeHome = await createProject();
    const installer = new HostIntegrationInstaller();
    const options = userOptions(fakeHome);

    await expect(installer.status(target, options)).resolves.toBe(
      "not-installed",
    );
    await expect(installer.install(target, options)).resolves.toEqual({
      target: target.id,
      scope: "user",
      skillDirectory: skillPath(fakeHome, target, "user"),
      mcpConfig: configPath(fakeHome, target, "user"),
      changed: true,
    });
    await expect(installer.status(target, options)).resolves.toBe("installed");
    await expect(installer.install(target, options)).resolves.toMatchObject({
      scope: "user",
      changed: false,
    });
    await expect(installer.uninstall(target, options)).resolves.toMatchObject({
      scope: "user",
      changed: true,
    });
    await expect(installer.status(target, options)).resolves.toBe(
      "not-installed",
    );
  });

  test("installs exact bytes, preserves config, is idempotent, and uninstalls", async () => {
    const root = await createProject();
    const installer = new HostIntegrationInstaller();
    await seedConfig(root, target);
    await expect(installer.status(target, projectOptions(root))).resolves.toBe(
      "not-installed",
    );

    const installed = await installer.install(target, projectOptions(root));
    expect(installed).toEqual({
      target: target.id,
      scope: "project",
      skillDirectory: skillPath(root, target),
      mcpConfig: configPath(root, target),
      changed: true,
    });
    await expect(installer.status(target, projectOptions(root))).resolves.toBe(
      "installed",
    );
    await expectManagedConfig(root, target);
    expect((await stat(configPath(root, target))).mode & 0o777).toBe(0o600);

    const canonical = await readTree(
      path.join(process.cwd(), "integrations/openwiki"),
    );
    const copied = await readTree(skillPath(root, target));
    const receiptText = copied[RECEIPT_FILE];
    delete copied[RECEIPT_FILE];
    expect(copied).toEqual(canonical);
    expect(receiptText).not.toContain(process.cwd());
    expect(receiptText).not.toContain(CONFIG_SENTINEL);
    const receipt: unknown = JSON.parse(receiptText ?? "");
    expect(receipt).toMatchObject({
      package: "openwiki",
      version: OPENWIKI_VERSION,
      target: target.id,
      mcpServerCommand: defaultMcpServerCommand(target.id),
    });
    expect(receipt).not.toHaveProperty("schemaVersion");

    await expect(
      installer.install(target, projectOptions(root)),
    ).resolves.toMatchObject({ changed: false });

    await expect(
      installer.uninstall(target, projectOptions(root)),
    ).resolves.toMatchObject({ changed: true });
    await expect(access(skillPath(root, target))).rejects.toThrow();
    await expect(installer.status(target, projectOptions(root))).resolves.toBe(
      "not-installed",
    );
    const remainingConfig = await readFile(configPath(root, target), "utf8");
    expect(remainingConfig).toContain(CONFIG_SENTINEL);
    expect(remainingConfig).not.toContain("openwiki");
    const protectedDirectory = path.join(
      root,
      target.project.skillDirectory.split("/", 1)[0] ?? "",
    );
    expect((await lstat(protectedDirectory)).isDirectory()).toBe(true);
  });

  test("replaces the default MCP command with a local development command", async () => {
    const root = await createProject();
    const installer = new HostIntegrationInstaller();
    const options = projectOptions(root);
    const localCommand = {
      command: "/opt/node/bin/node",
      args: ["/repo/dist/cli/cli.js", "mcp", "--host", target.id],
    };

    await installer.install(target, options);
    await expect(
      installer.install(target, {
        ...options,
        mcpServerCommand: localCommand,
      }),
    ).resolves.toMatchObject({ changed: true });

    const content = await readFile(configPath(root, target), "utf8");
    const kind = target.project.mcpConfig.kind;
    if (kind === "json") {
      expect(JSON.parse(content)).toMatchObject({
        mcpServers: { openwiki: localCommand },
      });
    } else if (kind === "opencode-json") {
      expect(JSON.parse(content)).toMatchObject({
        mcp: {
          openwiki: {
            type: "local",
            command: [localCommand.command, ...localCommand.args],
            enabled: true,
          },
        },
      });
    } else {
      expect(content).toContain(
        `command = ${JSON.stringify(localCommand.command)}`,
      );
      expect(content).toContain(
        `args = [${localCommand.args.map((argument) => JSON.stringify(argument)).join(", ")}]`,
      );
    }

    await expect(installer.status(target, options)).resolves.toBe("installed");
    await expect(
      installer.install(target, {
        ...options,
        mcpServerCommand: {
          ...localCommand,
          command: "/opt/new-node/bin/node",
        },
      }),
    ).resolves.toMatchObject({ changed: true });
    await expect(installer.status(target, options)).resolves.toBe("installed");
    await expect(installer.install(target, options)).resolves.toMatchObject({
      changed: true,
    });
    await expect(installer.status(target, options)).resolves.toBe("installed");
    await expect(installer.uninstall(target, options)).resolves.toMatchObject({
      changed: true,
    });
  });

  test("creates a missing config and performs a managed upgrade", async () => {
    const root = await createProject();
    const installer = new HostIntegrationInstaller();

    await expect(
      installer.install(target, projectOptions(root)),
    ).resolves.toMatchObject({ changed: true });
    await access(configPath(root, target));
    await markReceiptOld(skillPath(root, target));

    await expect(
      installer.install(target, projectOptions(root)),
    ).resolves.toEqual({
      target: target.id,
      scope: "project",
      skillDirectory: skillPath(root, target),
      mcpConfig: configPath(root, target),
      changed: true,
    });
    const receipt: unknown = JSON.parse(
      await readFile(path.join(skillPath(root, target), RECEIPT_FILE), "utf8"),
    );
    expect(receipt).toMatchObject({ version: OPENWIKI_VERSION });
  });

  test("refuses unmanaged or modified skills and preserves a forced backup", async () => {
    const root = await createProject();
    const destination = skillPath(root, target);
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "custom.md"), "CUSTOM_SKILL\n");
    const installer = new HostIntegrationInstaller({
      now: () => new Date("2026-08-20T01:02:03.000Z"),
      createId: () => "fixed-id",
    });

    await expect(
      installer.install(target, projectOptions(root)),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(access(configPath(root, target))).rejects.toThrow();

    const forced = await installer.install(target, {
      ...projectOptions(root),
      force: true,
    });
    expect(forced.backupPath).toContain("openwiki-backup-2026-08-20T01-02-03");
    expect(
      await readFile(path.join(forced.backupPath ?? "", "custom.md"), "utf8"),
    ).toBe("CUSTOM_SKILL\n");

    await writeFile(path.join(destination, "extra.md"), "MODIFIED\n");
    await expect(installer.status(target, projectOptions(root))).resolves.toBe(
      "modified",
    );
    await expect(
      installer.uninstall(target, projectOptions(root)),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      installer.install(target, projectOptions(root)),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("preserves malformed config bytes and cleans staging", async () => {
    const root = await createProject();
    const malformed = await writeMalformedConfig(root, target);
    const installer = new HostIntegrationInstaller();

    await expect(
      installer.install(target, projectOptions(root)),
    ).rejects.toBeInstanceOf(Error);
    expect(await readFile(configPath(root, target), "utf8")).toBe(malformed);
    await expect(access(skillPath(root, target))).rejects.toThrow();
    const siblings = await readdir(path.dirname(skillPath(root, target)));
    expect(siblings.some((name) => name.includes("openwiki-staging"))).toBe(
      false,
    );
  });

  test("rolls back config when an injected fresh commit fails", async () => {
    const root = await createProject();
    const installer = new HostIntegrationInstaller({
      operations: failingCommitOperations(),
      createId: () => "fresh-failure",
    });

    await expect(
      installer.install(target, projectOptions(root)),
    ).rejects.toThrow("INJECTED_COMMIT_FAILURE");
    await expect(access(skillPath(root, target))).rejects.toThrow();
    await expect(access(configPath(root, target))).rejects.toThrow();
    const siblings = await readdir(path.dirname(skillPath(root, target)));
    expect(siblings.some((name) => name.includes("openwiki-staging"))).toBe(
      false,
    );
  });

  test("leaves an existing skill in place when its backup move fails", async () => {
    const root = await createProject();
    const destination = skillPath(root, target);
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "custom.md"), "PRESERVED\n", "utf8");
    const installer = new HostIntegrationInstaller({
      operations: failingPriorMoveOperations(destination),
      createId: () => "prior-move-failure",
    });

    await expect(
      installer.install(target, { ...projectOptions(root), force: true }),
    ).rejects.toThrow("INJECTED_PRIOR_MOVE_FAILURE");
    expect(await readFile(path.join(destination, "custom.md"), "utf8")).toBe(
      "PRESERVED\n",
    );
    await expect(access(configPath(root, target))).rejects.toThrow();
  });

  test("restores an older skill and config absence after upgrade failure", async () => {
    const root = await createProject();
    const initial = new HostIntegrationInstaller();
    await initial.install(target, projectOptions(root));
    await markReceiptOld(skillPath(root, target));
    await rm(configPath(root, target));
    const before = await readTree(skillPath(root, target));
    let identifier = 0;
    const failing = new HostIntegrationInstaller({
      operations: failingCommitOperations(),
      createId: () => `upgrade-${(identifier += 1)}`,
    });

    await expect(failing.install(target, projectOptions(root))).rejects.toThrow(
      "INJECTED_COMMIT_FAILURE",
    );
    expect(await readTree(skillPath(root, target))).toEqual(before);
    await expect(access(configPath(root, target))).rejects.toThrow();
  });

  test("returns retained backups when post-commit cleanup fails", async () => {
    const upgradeRoot = await createProject();
    const initial = new HostIntegrationInstaller();
    await initial.install(target, projectOptions(upgradeRoot));
    await markReceiptOld(skillPath(upgradeRoot, target));
    const upgrade = new HostIntegrationInstaller({
      operations: failingCleanupOperations("rollback"),
      createId: () => "upgrade-cleanup",
    });

    const upgraded = await upgrade.install(target, projectOptions(upgradeRoot));
    expect(upgraded.backupPath).toContain("openwiki-rollback");
    await access(upgraded.backupPath ?? "");
    await expect(
      upgrade.status(target, projectOptions(upgradeRoot)),
    ).resolves.toBe("installed");

    const uninstallRoot = await createProject();
    await initial.install(target, projectOptions(uninstallRoot));
    const uninstall = new HostIntegrationInstaller({
      operations: failingCleanupOperations("uninstall"),
      createId: () => "uninstall-cleanup",
    });
    const removed = await uninstall.uninstall(
      target,
      projectOptions(uninstallRoot),
    );
    expect(removed.backupPath).toContain("openwiki-uninstall");
    await access(removed.backupPath ?? "");
    await expect(
      uninstall.status(target, projectOptions(uninstallRoot)),
    ).resolves.toBe("not-installed");
  });

  test("refuses uninstall when managed config was modified", async () => {
    const root = await createProject();
    const installer = new HostIntegrationInstaller();
    await installer.install(target, projectOptions(root));
    await modifyManagedConfig(root, target);

    await expect(installer.status(target, projectOptions(root))).resolves.toBe(
      "modified",
    );
    await expect(
      installer.uninstall(target, projectOptions(root)),
    ).rejects.toMatchObject({ code: "conflict" });
    await access(skillPath(root, target));
  });

  test("uninstall removes an orphaned managed config entry", async () => {
    const root = await createProject();
    const options = projectOptions(root);
    const installer = new HostIntegrationInstaller();
    await installer.install(target, options);
    await rm(skillPath(root, target), { force: true, recursive: true });

    await expect(installer.status(target, options)).resolves.toBe("modified");
    await expect(installer.uninstall(target, options)).resolves.toMatchObject({
      changed: true,
    });
    const content = await readFile(configPath(root, target), "utf8");
    expect(content).not.toContain("openwiki");
    await expect(installer.status(target, options)).resolves.toBe(
      "not-installed",
    );
  });

  test("uninstall removes an orphaned managed skill", async () => {
    const root = await createProject();
    const options = projectOptions(root);
    const installer = new HostIntegrationInstaller();
    await installer.install(target, options);
    await rm(configPath(root, target), { force: true });

    await expect(installer.status(target, options)).resolves.toBe("modified");
    await expect(installer.uninstall(target, options)).resolves.toMatchObject({
      changed: true,
    });
    await expect(access(skillPath(root, target))).rejects.toThrow();
    await expect(installer.status(target, options)).resolves.toBe(
      "not-installed",
    );
  });

  test("rejects symlinked destination components", async () => {
    const root = await createProject();
    const outside = await createDirectory();
    const topLevel = target.project.skillDirectory.split("/", 1)[0] ?? "";
    await symlink(outside, path.join(root, topLevel));
    const installer = new HostIntegrationInstaller();

    await expect(
      installer.install(target, projectOptions(root)),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("host integration scope ownership", () => {
  test("keeps user and project installations independent", async () => {
    const fakeHome = await createDirectory();
    const projectRoot = path.join(fakeHome, "project");
    await mkdir(projectRoot);
    execFileSync("git", ["init", "--quiet", projectRoot]);
    const target = HOST_TARGETS.codex;
    const installer = new HostIntegrationInstaller();

    await installer.install(target, userOptions(fakeHome));
    await installer.install(target, projectOptions(projectRoot));
    await installer.uninstall(target, userOptions(fakeHome));

    await expect(access(skillPath(fakeHome, target, "user"))).rejects.toThrow();
    await expect(
      installer.status(target, projectOptions(projectRoot)),
    ).resolves.toBe("installed");
    await access(skillPath(projectRoot, target, "project"));
  });
});

describe("project integration root resolution", () => {
  test.each(TARGETS)(
    "$displayName installs from a subdirectory at the Git repository root",
    async (target) => {
      const root = await createProject();
      const nested = path.join(root, "packages", "example");
      await mkdir(nested, { recursive: true });
      const installer = new HostIntegrationInstaller();

      const result = await installer.install(target, projectOptions(nested));

      expect(result.skillDirectory).toBe(skillPath(root, target));
      expect(result.mcpConfig).toBe(configPath(root, target));
      await access(skillPath(root, target));
      await expect(
        access(path.join(nested, target.project.skillDirectory)),
      ).rejects.toThrow();
    },
  );

  test("rejects project installation outside a Git repository", async () => {
    const directory = await createDirectory();
    const installer = new HostIntegrationInstaller();

    await expect(
      installer.install(HOST_TARGETS.codex, projectOptions(directory)),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "The OpenWiki root must be inside a Git repository.",
    });
    await expect(access(path.join(directory, ".agents"))).rejects.toThrow();
  });
});

describe("host directory cleanup", () => {
  test("preserves the host directory derived from the skill path", async () => {
    const root = await createDirectory();
    const hostRoot = path.join(root, ".future-host");
    const skillDirectory = path.join(hostRoot, "nested", "skills", "openwiki");
    await mkdir(skillDirectory, { recursive: true });
    await rm(skillDirectory, { recursive: true });

    await removeEmptySkillParents(root, skillDirectory);

    await expect(access(hostRoot)).resolves.toBeUndefined();
    await expect(access(path.join(hostRoot, "nested"))).rejects.toThrow();
  });
});

describe("canonical skill bundle resolution", () => {
  test("resolves the same package bundle from source and built layouts", () => {
    const packageRoot = process.cwd();
    const expected = path.join(packageRoot, "integrations/openwiki");
    const sourceUrl = pathToFileURL(
      path.join(packageRoot, "src/integrations/install/installer.ts"),
    ).href;
    const builtUrl = pathToFileURL(
      path.join(packageRoot, "dist/integrations/install/installer.js"),
    ).href;

    expect(resolveCanonicalSkillBundle(sourceUrl)).toBe(expected);
    expect(resolveCanonicalSkillBundle(builtUrl)).toBe(expected);
  });
});
