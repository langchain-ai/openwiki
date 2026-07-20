import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { synchronizeAgentCliWikiIndexes } from "../src/agent/index.ts";

function document(title: string, description: string): string {
  return `---\ntype: Reference\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${title}\n`;
}

async function repositoryWiki() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-agent-cli-"));
  await mkdir(path.join(rootDir, "openwiki/architecture"), { recursive: true });
  await writeFile(
    path.join(rootDir, "openwiki/quickstart.md"),
    document("Quickstart", "Start here."),
    "utf8",
  );
  await writeFile(
    path.join(rootDir, "openwiki/architecture/overview.md"),
    document("Architecture overview", "How the system is structured."),
    "utf8",
  );
  return rootDir;
}

describe("synchronizeAgentCliWikiIndexes", () => {
  test("writes an OKF root index for a repository wiki", async () => {
    const rootDir = await repositoryWiki();

    await synchronizeAgentCliWikiIndexes("update", rootDir, "repository");

    const rootIndex = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );

    expect(rootIndex).toContain('okf_version: "0.1"');
    expect(rootIndex).toContain("- [Quickstart](quickstart.md) - Start here.");
  });

  test("writes indexes for nested wiki directories", async () => {
    const rootDir = await repositoryWiki();

    await synchronizeAgentCliWikiIndexes("update", rootDir, "repository");

    const nestedIndex = await readFile(
      path.join(rootDir, "openwiki/architecture/index.md"),
      "utf8",
    );

    expect(nestedIndex).toContain(
      "- [Architecture overview](overview.md) - How the system is structured.",
    );
    expect(nestedIndex).not.toContain('okf_version: "0.1"');
  });

  test("leaves the wiki untouched for chat runs", async () => {
    const rootDir = await repositoryWiki();

    await synchronizeAgentCliWikiIndexes("chat", rootDir, "repository");

    await expect(
      readFile(path.join(rootDir, "openwiki/index.md"), "utf8"),
    ).rejects.toThrow();
  });
});
