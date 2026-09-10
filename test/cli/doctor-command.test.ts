import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parseCommand } from "../../src/cli/commands.ts";
import { runWikiDoctor } from "../../src/doctor/doctor.ts";

async function setupRepository(files: Record<string, string>) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-doctor-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }

  return rootDir;
}

describe("parseCommand doctor", () => {
  test("takes no arguments", () => {
    expect(parseCommand(["doctor"])).toEqual({ kind: "doctor", exitCode: 0 });
  });

  test("rejects an unknown option", () => {
    expect(parseCommand(["doctor", "--nope"])).toEqual({
      kind: "error",
      exitCode: 1,
      message: "Unknown option for doctor: --nope",
    });
  });
});

describe("runWikiDoctor", () => {
  test("reports a moved file and flags the run as having issues", async () => {
    const rootDir = await setupRepository({
      "src/cli/commands.ts": "export const parsed = true;\n",
      "openwiki/overview.md":
        "# Overview\n\nCLI parsing lives in `src/commands.ts`.\n",
    });

    const result = await runWikiDoctor(rootDir);

    expect(result.hasIssues).toBe(true);
    expect(result.report).toContain("Stale source references (1)");
    expect(result.report).toContain("openwiki/overview.md");
    expect(result.report).toContain(
      "line 3: src/commands.ts -> src/cli/commands.ts",
    );
  });

  test("reports a clean wiki without flagging issues", async () => {
    const rootDir = await setupRepository({
      "src/agent/index.ts": "export const run = 1;\n",
      "openwiki/overview.md": "# Overview\n\nSee `src/agent/index.ts`.\n",
    });

    const result = await runWikiDoctor(rootDir);

    expect(result.hasIssues).toBe(false);
    expect(result.report).toContain(
      "Scanned 1 page and 1 source citation in openwiki/.",
    );
    expect(result.report).toContain(
      "Source references: every cited file exists.",
    );
  });

  test("omits the staleness section outside a git repository", async () => {
    const rootDir = await setupRepository({
      "src/agent/index.ts": "export const run = 1;\n",
      "openwiki/.last-update.json": '{"gitHead":"0000000000000000"}\n',
      "openwiki/overview.md": "# Overview\n\nSee `src/agent/index.ts`.\n",
    });

    const result = await runWikiDoctor(rootDir);

    expect(result.report).not.toContain("changed since");
  });

  test("explains how to fix a repository with no wiki", async () => {
    const rootDir = await setupRepository({
      "src/agent/index.ts": "export {};\n",
    });

    await expect(runWikiDoctor(rootDir)).rejects.toThrow(
      /No openwiki\/ directory in .*openwiki code --init/u,
    );
  });

  test("does not rewrite the wiki it inspects", async () => {
    const rootDir = await setupRepository({
      "src/cli/commands.ts": "export const parsed = true;\n",
      "openwiki/overview.md":
        "# Overview\n\nCLI parsing lives in `src/commands.ts`.\n",
    });

    await runWikiDoctor(rootDir);

    expect(
      await readFile(path.join(rootDir, "openwiki/overview.md"), "utf8"),
    ).toBe("# Overview\n\nCLI parsing lives in `src/commands.ts`.\n");
  });
});
