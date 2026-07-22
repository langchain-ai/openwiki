import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  getLangSmithRepoConfigPath,
  parseLangSmithRepoConfig,
  readLangSmithRepoConfig,
  sanitizeLangSmithApiBaseUrl,
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
  test("parses object entries, includeFeedback, and an allowlisted apiBaseUrl", () => {
    expect(
      parseLangSmithRepoConfig(
        JSON.stringify({
          apiBaseUrl: "  https://eu.api.smith.langchain.com  ",
          includeFeedback: true,
          projects: [{ name: " prod " }, { name: "staging" }],
        }),
      ),
    ).toEqual({
      apiBaseUrl: "https://eu.api.smith.langchain.com",
      includeFeedback: true,
      projects: [{ name: "prod" }, { name: "staging" }],
    });
  });

  test("keeps only the name from a project entry, dropping extra keys", () => {
    expect(
      parseLangSmithRepoConfig(
        JSON.stringify({ projects: [{ name: "p", weight: 5 }] }),
      ),
    ).toEqual({ projects: [{ name: "p" }] });
  });

  test.each([
    ["a bare-string entry", JSON.stringify({ projects: ["prod"] })],
    ["an entry missing name", JSON.stringify({ projects: [{ weight: 5 }] })],
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

  test("drops an apiBaseUrl that is not an official LangSmith host", () => {
    expect(
      parseLangSmithRepoConfig(
        JSON.stringify({
          apiBaseUrl: "https://attacker.example.com",
          projects: [{ name: "p" }],
        }),
      ),
    ).toEqual({ projects: [{ name: "p" }] });
  });
});

describe("sanitizeLangSmithApiBaseUrl", () => {
  test("keeps official https hosts, normalized to the origin", () => {
    expect(
      sanitizeLangSmithApiBaseUrl(
        "  https://api.smith.langchain.com/ignored  ",
      ),
    ).toBe("https://api.smith.langchain.com");
    expect(
      sanitizeLangSmithApiBaseUrl("https://eu.api.smith.langchain.com"),
    ).toBe("https://eu.api.smith.langchain.com");
  });

  test.each([
    ["a non-allowlisted host", "https://attacker.example.com"],
    ["a look-alike host", "https://api.smith.langchain.com.evil.com"],
    ["a link-local metadata IP", "https://169.254.169.254"],
    ["a non-https scheme", "http://api.smith.langchain.com"],
    ["a file scheme", "file:///etc/passwd"],
    ["embedded credentials", "https://user:pass@api.smith.langchain.com"],
    ["a non-URL string", "not a url"],
    ["a non-string value", 42],
    ["an empty string", "   "],
  ])("rejects %s", (_label, value) => {
    expect(sanitizeLangSmithApiBaseUrl(value)).toBeUndefined();
  });
});

describe("read/write round-trip", () => {
  test("writes only openwiki/.langsmith.json and reads it back", async () => {
    const root = await createTempRepo();
    const config = { includeFeedback: true, projects: [{ name: "prod" }] };

    await writeLangSmithRepoConfig(root, config);

    expect(await readdir(root)).toEqual(["openwiki"]);
    expect(await readdir(path.join(root, "openwiki"))).toEqual([
      ".langsmith.json",
    ]);
    expect(getLangSmithRepoConfigPath(root)).toBe(
      path.join(root, "openwiki", ".langsmith.json"),
    );
    await expect(readLangSmithRepoConfig(root)).resolves.toEqual(config);
  });

  test("returns undefined when the config file is absent", async () => {
    const root = await createTempRepo();

    await expect(readLangSmithRepoConfig(root)).resolves.toBeUndefined();
  });
});
