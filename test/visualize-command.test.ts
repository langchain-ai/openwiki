import { describe, expect, test } from "vitest";
import { parseCommand } from "../src/commands.ts";

describe("parseCommand visualize", () => {
  test("defaults: openwiki dir, port 4321, opens the browser", () => {
    expect(parseCommand(["visualize"])).toEqual({
      kind: "visualize",
      exitCode: 0,
      wikiDir: "openwiki",
      port: 4321,
      open: true,
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
    });
  });

  test("supports --port=NNNN form", () => {
    const command = parseCommand(["visualize", "--port=5000"]);
    expect(command.kind === "visualize" && command.port).toBe(5000);
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
