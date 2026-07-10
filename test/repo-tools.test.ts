import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { beforeAll, describe, expect, test } from "vitest";
import { createRepositoryDiscoveryTools } from "../src/agent/tools/repo-tools.ts";

function getTool(
  tools: StructuredToolInterface[],
  name: string,
): StructuredToolInterface {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }

  return tool;
}

async function listFiles(
  tools: StructuredToolInterface[],
  input: Record<string, unknown>,
): Promise<{ files: string[]; truncated: boolean; error?: string }> {
  const result = await getTool(
    tools,
    "openwiki_list_repository_files",
  ).invoke(input);

  return JSON.parse(typeof result === "string" ? result : JSON.stringify(result));
}

describe("createRepositoryDiscoveryTools", () => {
  let repoDir: string;
  let tools: StructuredToolInterface[];

  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-repo-tools-"));

    await mkdir(path.join(repoDir, "src", "nested"), { recursive: true });
    await mkdir(path.join(repoDir, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(repoDir, ".git"), { recursive: true });

    await writeFile(path.join(repoDir, "README.md"), "# readme\n");
    await writeFile(path.join(repoDir, "src", "index.ts"), "export {};\n");
    await writeFile(path.join(repoDir, "src", "nested", "util.ts"), "export {};\n");
    await writeFile(path.join(repoDir, "src", "styles.css"), "body{}\n");
    await writeFile(path.join(repoDir, "node_modules", "pkg", "dep.js"), "//\n");
    await writeFile(path.join(repoDir, ".git", "config"), "[core]\n");

    tools = createRepositoryDiscoveryTools({ cwd: repoDir });
  });

  test("lists files recursively with default exclusions", async () => {
    const { files } = await listFiles(tools, {});
    expect(files).toContain("README.md");
    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/nested/util.ts");
    expect(files.some((file) => file.includes("node_modules"))).toBe(false);
    expect(files.some((file) => file.includes(".git"))).toBe(false);
  });

  test("filters by extension", async () => {
    const { files } = await listFiles(tools, { extensions: ["ts"] });
    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/nested/util.ts");
    expect(files).not.toContain("README.md");
    expect(files).not.toContain("src/styles.css");
  });

  test("accepts extensions with leading dots", async () => {
    const { files } = await listFiles(tools, { extensions: [".css"] });
    expect(files).toEqual(["src/styles.css"]);
  });

  test("scopes discovery to a subdirectory", async () => {
    const { files } = await listFiles(tools, { directory: "src" });
    expect(files).toContain("src/index.ts");
    expect(files).not.toContain("README.md");
  });

  test("supports additional exclude directories", async () => {
    const { files } = await listFiles(tools, { excludeDirs: ["nested"] });
    expect(files).toContain("src/index.ts");
    expect(files).not.toContain("src/nested/util.ts");
  });

  test("rejects path traversal", async () => {
    const result = await listFiles(tools, { directory: "../.." });
    expect(result.error).toBeDefined();
  });

  test("enforces the entry cap", async () => {
    const bigRepo = await mkdtemp(path.join(os.tmpdir(), "openwiki-repo-big-"));
    await mkdir(bigRepo, { recursive: true });
    const writes: Promise<void>[] = [];
    for (let index = 0; index < 5200; index += 1) {
      writes.push(
        writeFile(path.join(bigRepo, `file-${index}.txt`), "x"),
      );
    }
    await Promise.all(writes);

    const bigTools = createRepositoryDiscoveryTools({ cwd: bigRepo });
    const result = await listFiles(bigTools, {});
    expect(result.truncated).toBe(true);
    expect(result.files.length).toBe(5000);
  });
});
