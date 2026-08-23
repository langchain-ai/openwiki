import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";
import { runIntegrationsCommand } from "../../src/cli/integrations.ts";
import {
  defaultMcpServerCommand,
  listHostTargets,
} from "../../src/integrations/install/registry.ts";
import type { HostTarget } from "../../src/integrations/install/types.ts";

let projectRoot: string;
let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let stdout: string[];
let stderr: string[];
let savedExitCode: typeof process.exitCode;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-dogfood-"));
  execFileSync("git", ["init", "--quiet", projectRoot]);
  stdout = [];
  stderr = [];
  savedExitCode = process.exitCode;
  stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  process.exitCode = savedExitCode;
  await rm(projectRoot, { force: true, recursive: true });
});

describe("host integration CLI dogfood", () => {
  test("installs, lists, reinstalls, and uninstalls in a disposable repository", async () => {
    await runIntegrationsCommand({
      kind: "integrations",
      action: "install",
      exitCode: 0,
      target: "codex",
      scope: "project",
      projectRoot,
      force: false,
    });

    expect(stdout.join("")).toContain("install Codex\n");
    expect(stderr.join("")).toBe("");
    await expect(
      stat(path.join(projectRoot, ".agents/skills/openwiki/SKILL.md")),
    ).resolves.toMatchObject({});
    expect(
      await readFile(path.join(projectRoot, ".codex/config.toml"), "utf8"),
    ).toContain('args = ["mcp", "--host", "codex"]');

    stdout = [];
    await runIntegrationsCommand({
      kind: "integrations",
      action: "list",
      exitCode: 0,
      target: null,
      scope: "project",
      projectRoot,
      force: false,
    });
    expect(stdout.join("")).toBe(
      "codex\tinstalled\tCodex\n" +
        "claude\tnot-installed\tClaude Code\n" +
        "opencode\tnot-installed\tOpenCode\n",
    );

    stdout = [];
    await runIntegrationsCommand({
      kind: "integrations",
      action: "install",
      exitCode: 0,
      target: "codex",
      scope: "project",
      projectRoot,
      force: false,
    });
    expect(stdout.join("")).toContain("unchanged Codex\n");

    stdout = [];
    await runIntegrationsCommand({
      kind: "integrations",
      action: "uninstall",
      exitCode: 0,
      target: "codex",
      scope: "project",
      projectRoot,
      force: false,
    });
    expect(stdout.join("")).toContain("uninstall Codex\n");
    await expect(
      stat(path.join(projectRoot, ".agents/skills/openwiki")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    stdout = [];
    await runIntegrationsCommand({
      kind: "integrations",
      action: "list",
      exitCode: 0,
      target: null,
      scope: "project",
      projectRoot,
      force: false,
    });
    expect(stdout.join("")).toContain("codex\tnot-installed\tCodex\n");
    expect(process.exitCode).toBe(0);
    expect(stderr.join("")).toBe("");
  });

  test.each(listHostTargets())(
    "$displayName reports, repairs, and uninstalls partial states",
    async (target) => {
      await install(target);

      await removeSkill(target);
      await expectListStatus(target, "modified");
      await install(target);
      await expectListStatus(target, "installed");

      await removeMcpEntry(target);
      await expectListStatus(target, "modified");
      await install(target);
      await expectListStatus(target, "installed");

      await removeSkill(target);
      await uninstall(target);
      await expectListStatus(target, "not-installed");

      await install(target);
      await removeMcpEntry(target);
      await uninstall(target);
      await expectListStatus(target, "not-installed");
      expect(stderr.join("")).toBe("");
    },
  );
});

/**
 * Runs one project-scoped integration install through the CLI boundary.
 *
 * @param target - Host integration to install.
 */
async function install(target: HostTarget): Promise<void> {
  stdout = [];
  await runIntegrationsCommand({
    kind: "integrations",
    action: "install",
    exitCode: 0,
    target: target.id,
    scope: "project",
    projectRoot,
    force: false,
  });
  expect(process.exitCode).toBe(0);
}

/**
 * Runs one project-scoped integration uninstall through the CLI boundary.
 *
 * @param target - Host integration to uninstall.
 */
async function uninstall(target: HostTarget): Promise<void> {
  stdout = [];
  await runIntegrationsCommand({
    kind: "integrations",
    action: "uninstall",
    exitCode: 0,
    target: target.id,
    scope: "project",
    projectRoot,
    force: false,
  });
  expect(stdout.join("")).toContain(`uninstall ${target.displayName}\n`);
  expect(process.exitCode).toBe(0);
}

/**
 * Asserts the exact list state reported for one host.
 *
 * @param target - Host integration to inspect.
 * @param status - Expected aggregate installation state.
 */
async function expectListStatus(
  target: HostTarget,
  status: "installed" | "modified" | "not-installed",
): Promise<void> {
  stdout = [];
  await runIntegrationsCommand({
    kind: "integrations",
    action: "list",
    exitCode: 0,
    target: null,
    scope: "project",
    projectRoot,
    force: false,
  });
  expect(stdout.join("")).toContain(
    `${target.id}\t${status}\t${target.displayName}\n`,
  );
  expect(process.exitCode).toBe(0);
}

/**
 * Simulates a user deleting the installed skill but leaving MCP configured.
 *
 * @param target - Host integration whose skill should be removed.
 */
async function removeSkill(target: HostTarget): Promise<void> {
  await rm(path.join(projectRoot, target.project.skillDirectory), {
    force: true,
    recursive: true,
  });
}

/**
 * Simulates a user removing only the OpenWiki MCP entry from host config.
 *
 * @param target - Host integration whose MCP entry should be removed.
 */
async function removeMcpEntry(target: HostTarget): Promise<void> {
  const configPath = path.join(
    projectRoot,
    target.project.mcpConfig.relativePath,
  );
  const content = await readFile(configPath, "utf8");
  const command = defaultMcpServerCommand(target.id);

  if (target.project.mcpConfig.kind === "json") {
    const parsed = JSON.parse(content) as {
      mcpServers?: Record<string, unknown>;
    };
    delete parsed.mcpServers?.openwiki;
    await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return;
  }

  if (target.project.mcpConfig.kind === "opencode-json") {
    const parsed = JSON.parse(content) as {
      mcp?: Record<string, unknown>;
    };
    delete parsed.mcp?.openwiki;
    await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return;
  }

  const managedBlock = [
    "# OPENWIKI:MCP:START",
    "[mcp_servers.openwiki]",
    `command = ${JSON.stringify(command.command)}`,
    `args = [${command.args.map((argument) => JSON.stringify(argument)).join(", ")}]`,
    "# OPENWIKI:MCP:END",
    "",
  ].join("\n");
  expect(content).toContain(managedBlock);
  await writeFile(configPath, content.replace(managedBlock, ""), "utf8");
}
