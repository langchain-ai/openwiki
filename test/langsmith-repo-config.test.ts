import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  getLangSmithRepoConfigPath,
  parseLangSmithRepoConfig,
  readLangSmithRepoConfig,
  withProject,
  withoutProject,
  writeLangSmithRepoConfig,
} from "../src/connectors/sources/langsmith/repo-config.ts";

const tempRoots: string[] = [];

async function createTempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openwiki-langsmith-repo-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("parseLangSmithRepoConfig", () => {
  test("parses a valid file with object entries and all optionals", () => {
    expect(
      parseLangSmithRepoConfig(
        JSON.stringify({
          apiBaseUrl: "  https://eu.api.smith.langchain.com  ",
          includeFeedback: true,
          maxTraces: 15,
          projects: [{ maxTraces: 20, name: " prod " }, { name: "staging" }],
        }),
      ),
    ).toEqual({
      apiBaseUrl: "https://eu.api.smith.langchain.com",
      includeFeedback: true,
      maxTraces: 15,
      projects: [{ maxTraces: 20, name: "prod" }, { name: "staging" }],
    });
  });

  test("drops non-positive maxTraces (per-project and global)", () => {
    expect(
      parseLangSmithRepoConfig(
        JSON.stringify({
          maxTraces: 0,
          projects: [{ maxTraces: -5, name: "p" }],
        }),
      ),
    ).toEqual({ projects: [{ name: "p" }] });
  });

  test.each([
    ["a bare-string entry", JSON.stringify({ projects: ["prod"] })],
    ["an entry missing name", JSON.stringify({ projects: [{ maxTraces: 5 }] })],
    ["an empty-string name", JSON.stringify({ projects: [{ name: "  " }] })],
    ["non-array projects", JSON.stringify({ projects: "prod" })],
    ["missing projects", "{}"],
    ["invalid JSON", "{nope"],
    ["a non-object root", "[]"],
    ["a null root", "null"],
    ["empty text", ""],
  ])("rejects %s", (_label, text) => {
    expect(parseLangSmithRepoConfig(text)).toBeUndefined();
  });

  test("a __proto__ key does not pollute the result or Object.prototype", () => {
    const result = parseLangSmithRepoConfig(
      '{"projects":[{"name":"p"}],"__proto__":{"polluted":true}}',
    );

    expect(result).toEqual({ projects: [{ name: "p" }] });
    expect({} as Record<string, unknown>).not.toHaveProperty("polluted");
  });
});

describe("read/write round-trip", () => {
  test("writes only openwiki/langsmith.json and reads it back", async () => {
    const root = await createTempRepo();
    const config = { includeFeedback: true, projects: [{ name: "prod" }] };

    await writeLangSmithRepoConfig(root, config);

    expect(await readdir(root)).toEqual(["openwiki"]);
    expect(await readdir(path.join(root, "openwiki"))).toEqual([
      "langsmith.json",
    ]);
    expect(getLangSmithRepoConfigPath(root)).toBe(
      path.join(root, "openwiki", "langsmith.json"),
    );
    await expect(readLangSmithRepoConfig(root)).resolves.toEqual(config);
  });

  test("returns undefined when the config file is absent", async () => {
    const root = await createTempRepo();

    await expect(readLangSmithRepoConfig(root)).resolves.toBeUndefined();
  });
});

describe("withProject / withoutProject", () => {
  test("withProject adds by name, dedupes, trims, preserves order and fields", () => {
    const base = {
      includeFeedback: true,
      projects: [{ name: "a" }, { maxTraces: 5, name: "b" }],
    };

    expect(withProject(base, "c")).toEqual({
      includeFeedback: true,
      projects: [{ name: "a" }, { maxTraces: 5, name: "b" }, { name: "c" }],
    });
    // Trimmed to an existing name -> unchanged (deduped by name).
    expect(withProject(base, " a ")).toEqual(base);
    // Empty/whitespace names are ignored.
    expect(withProject(base, "   ")).toEqual(base);
  });

  test("withProject seeds a fresh config from undefined", () => {
    expect(withProject(undefined, "prod")).toEqual({
      projects: [{ name: "prod" }],
    });
  });

  test("withoutProject removes by exact name and preserves fields", () => {
    const base = {
      apiBaseUrl: "https://eu",
      projects: [{ name: "a" }, { name: "b" }, { name: "c" }],
    };

    expect(withoutProject(base, "b")).toEqual({
      apiBaseUrl: "https://eu",
      projects: [{ name: "a" }, { name: "c" }],
    });
    expect(withoutProject(base, "z").projects).toHaveLength(3);
  });
});
