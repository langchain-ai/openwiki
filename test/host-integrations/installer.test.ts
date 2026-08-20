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
} from "../../src/host-integrations/install/installer.ts";
import {
  getHostTarget,
  HOST_TARGETS,
  listHostTargets,
} from "../../src/host-integrations/install/registry.ts";
import type { HostTarget } from "../../src/host-integrations/install/types.ts";
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
function skillPath(root: string, target: HostTarget): string {
  return path.join(root, target.skillDirectory);
}

/**
 * Resolves a target's absolute MCP config path below a test project.
 *
 * @param root - Test project root.
 * @param target - Registry target.
 * @returns Absolute config destination.
 */
function configPath(root: string, target: HostTarget): string {
  return path.join(root, target.mcpConfig.relativePath);
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
  const content =
    target.mcpConfig.kind === "json"
      ? `${JSON.stringify({
          note: CONFIG_SENTINEL,
          mcpServers: { other: { command: "other" } },
        })}\n`
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
  if (target.mcpConfig.kind === "json") {
    expect(JSON.parse(content)).toMatchObject({
      mcpServers: {
        other: { command: "other" },
        openwiki: {
          command: "openwiki",
          args: ["mcp", "--host", target.id],
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
    target.mcpConfig.kind === "json"
      ? "{ malformed json\n"
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
  if (target.mcpConfig.kind === "json") {
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
  test("defines isolated destinations for all supported hosts", () => {
    expect(HOST_TARGETS).toMatchObject({
      codex: {
        skillDirectory: ".agents/skills/openwiki",
        mcpConfig: {
          kind: "codex-toml",
          relativePath: ".codex/config.toml",
        },
      },
      claude: {
        skillDirectory: ".claude/skills/openwiki",
        mcpConfig: { kind: "json", relativePath: ".mcp.json" },
      },
      dcode: {
        skillDirectory: ".deepagents/skills/openwiki",
        mcpConfig: {
          kind: "json",
          relativePath: ".deepagents/.mcp.json",
        },
      },
    });
    expect(getHostTarget("codex")).toBe(HOST_TARGETS.codex);
    expect(getHostTarget("unsupported")).toBeUndefined();
    expect(TARGETS.map((target) => target.id)).toEqual([
      "codex",
      "claude",
      "dcode",
    ]);
    expect(new Set(TARGETS.map((target) => target.skillDirectory)).size).toBe(
      TARGETS.length,
    );
  });
});

describe.each(TARGETS)("$displayName host integration", (target) => {
  test("installs exact bytes, preserves config, is idempotent, and uninstalls", async () => {
    const root = await createProject();
    const installer = new HostIntegrationInstaller();
    await seedConfig(root, target);
    await expect(installer.status(target, root)).resolves.toBe("not-installed");

    const installed = await installer.install(target, { projectRoot: root });
    expect(installed).toEqual({
      target: target.id,
      skillDirectory: skillPath(root, target),
      mcpConfig: configPath(root, target),
      changed: true,
    });
    await expect(installer.status(target, root)).resolves.toBe("installed");
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
      schemaVersion: 1,
      package: "openwiki",
      version: OPENWIKI_VERSION,
      target: target.id,
    });

    await expect(
      installer.install(target, { projectRoot: root }),
    ).resolves.toMatchObject({ changed: false });

    await expect(
      installer.uninstall(target, { projectRoot: root }),
    ).resolves.toMatchObject({ changed: true });
    await expect(access(skillPath(root, target))).rejects.toThrow();
    await expect(installer.status(target, root)).resolves.toBe("not-installed");
    const remainingConfig = await readFile(configPath(root, target), "utf8");
    expect(remainingConfig).toContain(CONFIG_SENTINEL);
    expect(remainingConfig).not.toContain("openwiki");
    const protectedDirectory = path.join(
      root,
      target.skillDirectory.split("/", 1)[0] ?? "",
    );
    expect((await lstat(protectedDirectory)).isDirectory()).toBe(true);
  });

  test("creates a missing config and performs a managed upgrade", async () => {
    const root = await createProject();
    const installer = new HostIntegrationInstaller();

    await expect(
      installer.install(target, { projectRoot: root }),
    ).resolves.toMatchObject({ changed: true });
    await access(configPath(root, target));
    await markReceiptOld(skillPath(root, target));

    await expect(
      installer.install(target, { projectRoot: root }),
    ).resolves.toEqual({
      target: target.id,
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
      installer.install(target, { projectRoot: root }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(access(configPath(root, target))).rejects.toThrow();

    const forced = await installer.install(target, {
      projectRoot: root,
      force: true,
    });
    expect(forced.backupPath).toContain("openwiki-backup-2026-08-20T01-02-03");
    expect(
      await readFile(path.join(forced.backupPath ?? "", "custom.md"), "utf8"),
    ).toBe("CUSTOM_SKILL\n");

    await writeFile(path.join(destination, "extra.md"), "MODIFIED\n");
    await expect(installer.status(target, root)).resolves.toBe("modified");
    await expect(
      installer.uninstall(target, { projectRoot: root }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      installer.install(target, { projectRoot: root }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("preserves malformed config bytes and cleans staging", async () => {
    const root = await createProject();
    const malformed = await writeMalformedConfig(root, target);
    const installer = new HostIntegrationInstaller();

    await expect(
      installer.install(target, { projectRoot: root }),
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
      installer.install(target, { projectRoot: root }),
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
      installer.install(target, { projectRoot: root, force: true }),
    ).rejects.toThrow("INJECTED_PRIOR_MOVE_FAILURE");
    expect(await readFile(path.join(destination, "custom.md"), "utf8")).toBe(
      "PRESERVED\n",
    );
    await expect(access(configPath(root, target))).rejects.toThrow();
  });

  test("restores an older skill and config absence after upgrade failure", async () => {
    const root = await createProject();
    const initial = new HostIntegrationInstaller();
    await initial.install(target, { projectRoot: root });
    await markReceiptOld(skillPath(root, target));
    await rm(configPath(root, target));
    const before = await readTree(skillPath(root, target));
    let identifier = 0;
    const failing = new HostIntegrationInstaller({
      operations: failingCommitOperations(),
      createId: () => `upgrade-${(identifier += 1)}`,
    });

    await expect(
      failing.install(target, { projectRoot: root }),
    ).rejects.toThrow("INJECTED_COMMIT_FAILURE");
    expect(await readTree(skillPath(root, target))).toEqual(before);
    await expect(access(configPath(root, target))).rejects.toThrow();
  });

  test("returns retained backups when post-commit cleanup fails", async () => {
    const upgradeRoot = await createProject();
    const initial = new HostIntegrationInstaller();
    await initial.install(target, { projectRoot: upgradeRoot });
    await markReceiptOld(skillPath(upgradeRoot, target));
    const upgrade = new HostIntegrationInstaller({
      operations: failingCleanupOperations("rollback"),
      createId: () => "upgrade-cleanup",
    });

    const upgraded = await upgrade.install(target, {
      projectRoot: upgradeRoot,
    });
    expect(upgraded.backupPath).toContain("openwiki-rollback");
    await access(upgraded.backupPath ?? "");
    await expect(upgrade.status(target, upgradeRoot)).resolves.toBe(
      "installed",
    );

    const uninstallRoot = await createProject();
    await initial.install(target, { projectRoot: uninstallRoot });
    const uninstall = new HostIntegrationInstaller({
      operations: failingCleanupOperations("uninstall"),
      createId: () => "uninstall-cleanup",
    });
    const removed = await uninstall.uninstall(target, {
      projectRoot: uninstallRoot,
    });
    expect(removed.backupPath).toContain("openwiki-uninstall");
    await access(removed.backupPath ?? "");
    await expect(uninstall.status(target, uninstallRoot)).resolves.toBe(
      "not-installed",
    );
  });

  test("refuses uninstall when managed config was modified", async () => {
    const root = await createProject();
    const installer = new HostIntegrationInstaller();
    await installer.install(target, { projectRoot: root });
    await modifyManagedConfig(root, target);

    await expect(installer.status(target, root)).resolves.toBe("modified");
    await expect(
      installer.uninstall(target, { projectRoot: root }),
    ).rejects.toMatchObject({ code: "conflict" });
    await access(skillPath(root, target));
  });

  test("rejects symlinked destination components", async () => {
    const root = await createProject();
    const outside = await createProject();
    const topLevel = target.skillDirectory.split("/", 1)[0] ?? "";
    await symlink(outside, path.join(root, topLevel));
    const installer = new HostIntegrationInstaller();

    await expect(
      installer.install(target, { projectRoot: root }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("canonical skill bundle resolution", () => {
  test("resolves the same package bundle from source and built layouts", () => {
    const packageRoot = process.cwd();
    const expected = path.join(packageRoot, "integrations/openwiki");
    const sourceUrl = pathToFileURL(
      path.join(packageRoot, "src/host-integrations/install/installer.ts"),
    ).href;
    const builtUrl = pathToFileURL(
      path.join(packageRoot, "dist/host-integrations/install/installer.js"),
    ).href;

    expect(resolveCanonicalSkillBundle(sourceUrl)).toBe(expected);
    expect(resolveCanonicalSkillBundle(builtUrl)).toBe(expected);
  });
});
