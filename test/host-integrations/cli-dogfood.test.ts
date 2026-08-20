import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
import { runIntegrationsCommand } from "../../src/cli/host-integrations.ts";

let projectRoot: string;
let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let stdout: string[];
let stderr: string[];
let savedExitCode: typeof process.exitCode;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-dogfood-"));
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
      projectRoot,
      force: false,
    });
    expect(stdout.join("")).toBe(
      "codex\tinstalled\tCodex\n" +
        "claude\tnot-installed\tClaude Code\n" +
        "dcode\tnot-installed\tDeep Agents Code\n",
    );

    stdout = [];
    await runIntegrationsCommand({
      kind: "integrations",
      action: "install",
      exitCode: 0,
      target: "codex",
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
      projectRoot,
      force: false,
    });
    expect(stdout.join("")).toContain("codex\tnot-installed\tCodex\n");
    expect(process.exitCode).toBe(0);
    expect(stderr.join("")).toBe("");
  });
});
