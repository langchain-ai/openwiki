import { describe, expect, test } from "vitest";
import { createCliInfoTools } from "../src/agent/tools/cli-info-tools.ts";
import { getHelpText } from "../src/commands.ts";

describe("createCliInfoTools", () => {
  test("openwiki_cli_help returns the CLI help text", async () => {
    const tools = createCliInfoTools();
    const tool = tools.find(
      (candidate) => candidate.name === "openwiki_cli_help",
    );
    expect(tool).toBeDefined();

    const result: unknown = await tool!.invoke({});
    const output = typeof result === "string" ? result : JSON.stringify(result);

    expect(output.length).toBeGreaterThan(0);
    expect(output).toBe(getHelpText());
    expect(output).toContain("Usage");
    expect(output).toContain("Commands");
    expect(output).toContain("Options");
  });
});
