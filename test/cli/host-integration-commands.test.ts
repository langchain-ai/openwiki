import { describe, expect, test } from "vitest";
import {
  commandEmitsTelemetry,
  commandLoadsEnvironment,
  getHelpText,
  parseCommand,
} from "../../src/cli/commands.ts";
import { listHostTargets } from "../../src/host-integrations/install/registry.ts";

describe("parseCommand host integrations", () => {
  test("parses list with the default or one explicit project path", () => {
    expect(parseCommand(["integrations", "list"])).toEqual({
      kind: "integrations",
      action: "list",
      exitCode: 0,
      target: null,
      projectRoot: ".",
      force: false,
    });
    expect(parseCommand(["integrations", "list", "../project"])).toEqual({
      kind: "integrations",
      action: "list",
      exitCode: 0,
      target: null,
      projectRoot: "../project",
      force: false,
    });
  });

  test.each(listHostTargets())(
    "parses install and uninstall for $id",
    (target) => {
      expect(
        parseCommand([
          "integrations",
          "install",
          target.id,
          "../project",
          "--force",
        ]),
      ).toEqual({
        kind: "integrations",
        action: "install",
        exitCode: 0,
        target: target.id,
        projectRoot: "../project",
        force: true,
      });
      expect(
        parseCommand(["integrations", "uninstall", target.id, "../project"]),
      ).toEqual({
        kind: "integrations",
        action: "uninstall",
        exitCode: 0,
        target: target.id,
        projectRoot: "../project",
        force: false,
      });
    },
  );

  test("allows --force before the optional install path", () => {
    expect(
      parseCommand(["integrations", "install", "codex", "--force", "repo"]),
    ).toMatchObject({
      kind: "integrations",
      projectRoot: "repo",
      force: true,
    });
  });

  test.each([
    [["integrations"], /Usage: openwiki integrations/u],
    [["integrations", "unknown"], /Usage: openwiki integrations/u],
    [["integrations", "install"], /Integration target is required/u],
    [
      ["integrations", "install", "other"],
      /Unknown integration target: other/u,
    ],
    [
      ["integrations", "list", "--force"],
      /only valid for integrations install/u,
    ],
    [
      ["integrations", "uninstall", "codex", "--force"],
      /only valid for integrations install/u,
    ],
    [
      ["integrations", "install", "codex", "--force", "--force"],
      /only be specified once/u,
    ],
    [
      ["integrations", "install", "codex", "one", "two"],
      /Only one integration project path/u,
    ],
    [
      ["integrations", "install", "codex", "--unknown"],
      /Unknown option for integrations/u,
    ],
  ])("rejects invalid integration arguments: %j", (argv, expected) => {
    const result = parseCommand(argv);
    expect(result.kind).toBe("error");
    expect(result.exitCode).toBe(1);
    if (result.kind === "error") expect(result.message).toMatch(expected);
  });

  test("derives help and target errors from the host registry", () => {
    const hostIds = listHostTargets().map((target) => target.id);
    const help = getHelpText();
    const error = parseCommand(["integrations", "install", "other"]);

    for (const id of hostIds) {
      expect(help).toContain(id);
      expect(error.kind).toBe("error");
      if (error.kind === "error") expect(error.message).toContain(id);
    }
  });
});

describe("parseCommand MCP", () => {
  test("uses safe defaults for manual MCP startup", () => {
    expect(parseCommand(["mcp"])).toEqual({
      kind: "mcp",
      exitCode: 0,
      root: ".",
      host: "unknown",
    });
  });

  test("parses separated and equals option forms in either order", () => {
    expect(
      parseCommand(["mcp", "--host", "claude", "--root", "../repo"]),
    ).toEqual({
      kind: "mcp",
      exitCode: 0,
      root: "../repo",
      host: "claude",
    });
    expect(
      parseCommand(["mcp", "--root=../repo", "--host=custom-host-2"]),
    ).toEqual({
      kind: "mcp",
      exitCode: 0,
      root: "../repo",
      host: "custom-host-2",
    });
  });

  test.each([
    [["mcp", "--root"], /--root requires a path/u],
    [["mcp", "--root="], /--root requires a path/u],
    [["mcp", "--host"], /--host requires a host identifier/u],
    [["mcp", "--host="], /--host requires a host identifier/u],
    [
      ["mcp", "--root", "one", "--root=two"],
      /--root may only be specified once/u,
    ],
    [
      ["mcp", "--host", "codex", "--host=dcode"],
      /--host may only be specified once/u,
    ],
    [["mcp", "--host", "Claude"], /--host must contain/u],
    [["mcp", "--host", "bad_host"], /--host must contain/u],
    [["mcp", "--host", "a".repeat(65)], /--host must contain/u],
    [["mcp", "--unknown"], /Unknown option for mcp/u],
    [["mcp", "repo"], /Unexpected argument for mcp/u],
  ])("rejects invalid MCP arguments: %j", (argv, expected) => {
    const result = parseCommand(argv);
    expect(result.kind).toBe("error");
    expect(result.exitCode).toBe(1);
    if (result.kind === "error") expect(result.message).toMatch(expected);
  });
});

describe("host command isolation", () => {
  test.each([
    ["integrations", "list"],
    ["integrations", "install", "codex"],
    ["mcp"],
  ])("%j bypasses credentials and telemetry", (...argv) => {
    const command = parseCommand(argv);

    expect(commandLoadsEnvironment(command)).toBe(false);
    expect(commandEmitsTelemetry(command)).toBe(false);
  });
});
