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
  test("parses a valid file, trimming projects and the base URL", () => {
    expect(
      parseLangSmithRepoConfig(
        JSON.stringify({
          apiBaseUrl: "  https://eu.api.smith.langchain.com  ",
          includeFeedback: true,
          projects: [" support-bot-prod ", "support-bot-staging"],
        }),
      ),
    ).toEqual({
      apiBaseUrl: "https://eu.api.smith.langchain.com",
      includeFeedback: true,
      projects: ["support-bot-prod", "support-bot-staging"],
    });
  });

  test("accepts an empty projects array as a valid empty config", () => {
    expect(parseLangSmithRepoConfig('{"projects":[]}')).toEqual({
      projects: [],
    });
  });

  test("keeps includeFeedback:false but drops non-boolean/empty optionals", () => {
    expect(
      parseLangSmithRepoConfig(
        JSON.stringify({
          apiBaseUrl: "   ",
          includeFeedback: false,
          projects: ["a"],
        }),
      ),
    ).toEqual({ includeFeedback: false, projects: ["a"] });

    expect(
      parseLangSmithRepoConfig(
        JSON.stringify({ includeFeedback: "yes", projects: ["a"] }),
      ),
    ).toEqual({ projects: ["a"] });
  });

  test.each([
    ["missing projects", "{}"],
    ["non-string element", JSON.stringify({ projects: ["a", 1] })],
    ["empty-string element", JSON.stringify({ projects: ["a", ""] })],
    ["whitespace-only element", JSON.stringify({ projects: ["  "] })],
    ["projects not an array", JSON.stringify({ projects: "a" })],
  ])("rejects %s", (_label, text) => {
    expect(parseLangSmithRepoConfig(text)).toBeUndefined();
  });

  test.each([
    ["invalid JSON", "{not json"],
    ["array root", "[]"],
    ["null root", "null"],
    ["number root", "42"],
    ["string root", '"nope"'],
    ["empty string", ""],
  ])("returns undefined for %s", (_label, text) => {
    expect(parseLangSmithRepoConfig(text)).toBeUndefined();
  });

  test("returns undefined for undefined input", () => {
    expect(parseLangSmithRepoConfig(undefined)).toBeUndefined();
  });

  test("a __proto__ key does not pollute the result or Object.prototype", () => {
    const result = parseLangSmithRepoConfig(
      '{"projects":["a"],"__proto__":{"polluted":true}}',
    );

    expect(result).toEqual({ projects: ["a"] });
    expect(Object.keys(result ?? {})).toEqual(["projects"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("read/write round-trip", () => {
  test("writes only openwiki/langsmith.json and reads it back", async () => {
    const root = await createTempRepo();
    const config = { includeFeedback: true, projects: ["prod"] };

    await writeLangSmithRepoConfig(root, config);

    // Nothing is written outside openwiki/.
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

  test("round-trips a scaffolded empty config", async () => {
    const root = await createTempRepo();
    await writeLangSmithRepoConfig(root, { projects: [] });

    await expect(readLangSmithRepoConfig(root)).resolves.toEqual({
      projects: [],
    });
  });
});

describe("withProject / withoutProject", () => {
  test("withProject adds, dedupes, trims, and preserves order and fields", () => {
    const base = { includeFeedback: true, projects: ["a", "b"] };

    expect(withProject(base, "c")).toEqual({
      includeFeedback: true,
      projects: ["a", "b", "c"],
    });
    // Trimmed to an existing name -> unchanged (deduped).
    expect(withProject(base, " a ")).toEqual(base);
    // Empty/whitespace names are ignored.
    expect(withProject(base, "   ")).toEqual(base);
  });

  test("withProject seeds a fresh config from undefined", () => {
    expect(withProject(undefined, "prod")).toEqual({ projects: ["prod"] });
  });

  test("withoutProject removes by exact name and preserves fields", () => {
    const base = { apiBaseUrl: "https://eu", projects: ["a", "b", "c"] };

    expect(withoutProject(base, "b")).toEqual({
      apiBaseUrl: "https://eu",
      projects: ["a", "c"],
    });
    // No exact match -> unchanged set.
    expect(withoutProject(base, "z").projects).toEqual(["a", "b", "c"]);
  });
});
