import { describe, expect, test } from "vitest";
import { parseCommand } from "../../src/cli/commands.ts";

describe("parseCommand visualize", () => {
  test("defaults: openwiki dir, port 4321, opens the browser", () => {
    expect(parseCommand(["visualize"])).toEqual({
      kind: "visualize",
      exitCode: 0,
      wikiDir: "openwiki",
      port: 4321,
      open: true,
      exportDir: null,
    });
  });

  test("accepts a positional dir, --port, and --no-open", () => {
    expect(
      parseCommand(["visualize", "docs/wiki", "--port", "4400", "--no-open"]),
    ).toEqual({
      kind: "visualize",
      exitCode: 0,
      wikiDir: "docs/wiki",
      port: 4400,
      open: false,
      exportDir: null,
    });
  });

  test("supports --port=NNNN form", () => {
    const command = parseCommand(["visualize", "--port=5000"]);
    expect(command.kind === "visualize" && command.port).toBe(5000);
    expect(command.kind === "visualize" && command.exportDir).toBeNull();
  });

  test("accepts a static export directory", () => {
    expect(
      parseCommand(["visualize", "openwiki", "--export", "docs/visualizer"]),
    ).toEqual({
      kind: "visualize",
      exitCode: 0,
      wikiDir: "openwiki",
      port: 4321,
      open: true,
      exportDir: "docs/visualizer",
    });
  });

  test("rejects an export without a directory", () => {
    expect(parseCommand(["visualize", "--export"])).toEqual({
      kind: "error",
      exitCode: 1,
      message: "--export requires a directory.",
    });
  });

  test("rejects server options with a static export", () => {
    expect(
      parseCommand([
        "visualize",
        "--export",
        "docs/visualizer",
        "--port",
        "4400",
      ]),
    ).toEqual({
      kind: "error",
      exitCode: 1,
      message: "--export cannot be combined with --port or --no-open.",
    });
  });

  test("rejects an out-of-range port", () => {
    expect(parseCommand(["visualize", "--port", "80"])).toEqual({
      kind: "error",
      exitCode: 1,
      message: "--port must be between 1024 and 65535.",
    });
  });

  test("rejects a missing --port value", () => {
    expect(parseCommand(["visualize", "--port"])).toEqual({
      kind: "error",
      exitCode: 1,
      message: "--port requires a value.",
    });
  });

  test("rejects an unknown option", () => {
    const command = parseCommand(["visualize", "--nope"]);
    expect(command.kind).toBe("error");
  });
});
