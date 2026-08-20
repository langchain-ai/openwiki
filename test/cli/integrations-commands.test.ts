import { describe, expect, test } from "vitest";
import {
  commandEmitsTelemetry,
  commandLoadsEnvironment,
  getHelpText,
  parseCommand,
} from "../../src/cli/commands.ts";
import { listHostTargets } from "../../src/integrations/install/registry.ts";

describe("parseCommand host integrations", () => {
  test("parses list with global default or explicit project scope", () => {
    expect(parseCommand(["integrations", "list"])).toEqual({
      kind: "integrations",
      action: "list",
      exitCode: 0,
      target: null,
      scope: "user",
      projectRoot: null,
      force: false,
    });
    expect(
      parseCommand(["integrations", "list", "--project", "../project"]),
    ).toEqual({
      kind: "integrations",
      action: "list",
      exitCode: 0,
      target: null,
      scope: "project",
      projectRoot: "../project",
      force: false,
    });
    expect(parseCommand(["integrations", "list", "--project"])).toMatchObject({
      kind: "integrations",
      scope: "project",
      projectRoot: ".",
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
          "--force",
          "--project=../project",
        ]),
      ).toEqual({
        kind: "integrations",
        action: "install",
        exitCode: 0,
        target: target.id,
        scope: "project",
        projectRoot: "../project",
        force: true,
      });
      expect(
        parseCommand([
          "integrations",
          "uninstall",
          target.id,
          "--project",
          "../project",
        ]),
      ).toEqual({
        kind: "integrations",
        action: "uninstall",
        exitCode: 0,
        target: target.id,
        scope: "project",
        projectRoot: "../project",
        force: false,
      });
    },
  );

  test("allows --force before project scope", () => {
    expect(
      parseCommand([
        "integrations",
        "install",
        "codex",
        "--force",
        "--project",
        "repo",
      ]),
    ).toMatchObject({
      kind: "integrations",
      scope: "project",
      projectRoot: "repo",
      force: true,
    });
  });

  test("defaults install and uninstall to user scope", () => {
    expect(parseCommand(["integrations", "install", "codex"])).toMatchObject({
      kind: "integrations",
      scope: "user",
      projectRoot: null,
    });
    expect(parseCommand(["integrations", "uninstall", "codex"])).toMatchObject({
      kind: "integrations",
      scope: "user",
      projectRoot: null,
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
    [["integrations", "install", "codex", "repo"], /must follow --project/u],
    [
      ["integrations", "install", "codex", "--unknown"],
      /Unknown option for integrations/u,
    ],
    [["integrations", "install", "codex", "--project="], /requires a path/u],
    [
      ["integrations", "install", "codex", "--project", "--project"],
      /only be specified once/u,
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
      host: "unknown",
    });
  });

  test("parses separated and equals host option forms", () => {
    expect(parseCommand(["mcp", "--host", "claude"])).toEqual({
      kind: "mcp",
      exitCode: 0,
      host: "claude",
    });
    expect(parseCommand(["mcp", "--host=custom-host-2"])).toEqual({
      kind: "mcp",
      exitCode: 0,
      host: "custom-host-2",
    });
  });

  test.each([
    [["mcp", "--host"], /--host requires a host identifier/u],
    [["mcp", "--host="], /--host requires a host identifier/u],
    [
      ["mcp", "--host", "codex", "--host=other"],
      /--host may only be specified once/u,
    ],
    [["mcp", "--host", "Claude"], /--host must contain/u],
    [["mcp", "--host", "bad_host"], /--host must contain/u],
    [["mcp", "--host", "a".repeat(65)], /--host must contain/u],
    [["mcp", "--unknown"], /Unknown option for mcp/u],
    [["mcp", "--root", "repo"], /Unknown option for mcp/u],
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
