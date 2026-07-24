import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  getLangSmithRepoConfigPath,
  parseLangSmithRepoConfig,
  readLangSmithRepoConfig,
  sanitizeLangSmithApiBaseUrl,
  sanitizeLangSmithApiKeyEnv,
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
  test("parses a workspace with an allowlisted apiBaseUrl and apiKeyEnv", () => {
    expect(
      parseLangSmithRepoConfig(
        JSON.stringify({
          workspaces: [
            {
              apiBaseUrl: "  https://eu.api.smith.langchain.com  ",
              apiKeyEnv: " OPENWIKI_LANGSMITH_API_KEY_2 ",
              projects: [{ name: " prod " }, { name: "staging" }],
            },
          ],
        }),
      ),
    ).toEqual({
      workspaces: [
        {
          apiBaseUrl: "https://eu.api.smith.langchain.com",
          apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY_2",
          projects: [{ name: "prod" }, { name: "staging" }],
        },
      ],
    });
  });

  test("omits apiBaseUrl for a US workspace (default host)", () => {
    expect(
      parseLangSmithRepoConfig(
        JSON.stringify({
          workspaces: [
            {
              apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY",
              projects: [{ name: "p" }],
            },
          ],
        }),
      ),
    ).toEqual({
      workspaces: [
        { apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY", projects: [{ name: "p" }] },
      ],
    });
  });

  test("keeps only the name from a project entry, dropping extra keys", () => {
    expect(
      parseLangSmithRepoConfig(
        JSON.stringify({
          workspaces: [
            {
              apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY",
              projects: [{ name: "p", weight: 5 }],
            },
          ],
        }),
      ),
    ).toEqual({
      workspaces: [
        { apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY", projects: [{ name: "p" }] },
      ],
    });
  });

  test("drops a workspace whose apiKeyEnv is outside the OpenWiki namespace", () => {
    // Guards against a committed config exfiltrating an unrelated secret.
    expect(
      parseLangSmithRepoConfig(
        JSON.stringify({
          workspaces: [
            {
              apiKeyEnv: "AWS_SECRET_ACCESS_KEY",
              projects: [{ name: "evil" }],
            },
            {
              apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY",
              projects: [{ name: "ok" }],
            },
          ],
        }),
      ),
    ).toEqual({
      workspaces: [
        { apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY", projects: [{ name: "ok" }] },
      ],
    });
  });

  test("drops a workspace with a malformed project, keeping the valid one", () => {
    expect(
      parseLangSmithRepoConfig(
        JSON.stringify({
          workspaces: [
            { apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY", projects: ["bare"] },
            {
              apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY_2",
              projects: [{ name: "ok" }],
            },
          ],
        }),
      ),
    ).toEqual({
      workspaces: [
        {
          apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY_2",
          projects: [{ name: "ok" }],
        },
      ],
    });
  });

  test("drops a non-allowlisted apiBaseUrl but keeps the workspace", () => {
    expect(
      parseLangSmithRepoConfig(
        JSON.stringify({
          workspaces: [
            {
              apiBaseUrl: "https://attacker.example.com",
              apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY",
              projects: [{ name: "p" }],
            },
          ],
        }),
      ),
    ).toEqual({
      workspaces: [
        { apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY", projects: [{ name: "p" }] },
      ],
    });
  });

  test.each([
    ["non-array workspaces", JSON.stringify({ workspaces: "x" })],
    ["missing workspaces", "{}"],
    ["invalid JSON", "{nope"],
    ["a non-object root", "[]"],
    ["a null root", "null"],
    ["empty text", ""],
  ])("rejects %s", (_label, text) => {
    expect(parseLangSmithRepoConfig(text)).toBeUndefined();
  });

  test("a __proto__ key does not pollute the result or Object.prototype", () => {
    const result = parseLangSmithRepoConfig(
      '{"workspaces":[{"apiKeyEnv":"OPENWIKI_LANGSMITH_API_KEY","projects":[{"name":"p"}]}],"__proto__":{"polluted":true}}',
    );

    expect(result).toEqual({
      workspaces: [
        { apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY", projects: [{ name: "p" }] },
      ],
    });
    expect({} as Record<string, unknown>).not.toHaveProperty("polluted");
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

describe("sanitizeLangSmithApiKeyEnv", () => {
  test.each([
    ["the base name", "OPENWIKI_LANGSMITH_API_KEY"],
    ["a numeric suffix", "OPENWIKI_LANGSMITH_API_KEY_2"],
    ["an uppercase suffix", "OPENWIKI_LANGSMITH_API_KEY_EU"],
  ])("accepts %s", (_label, value) => {
    expect(sanitizeLangSmithApiKeyEnv(value)).toBe(value);
  });

  test("trims surrounding whitespace", () => {
    expect(sanitizeLangSmithApiKeyEnv("  OPENWIKI_LANGSMITH_API_KEY  ")).toBe(
      "OPENWIKI_LANGSMITH_API_KEY",
    );
  });

  test.each([
    ["an unrelated secret", "AWS_SECRET_ACCESS_KEY"],
    ["a lowercase suffix", "OPENWIKI_LANGSMITH_API_KEY_eu"],
    ["a prefix escape", "XOPENWIKI_LANGSMITH_API_KEY"],
    ["an injected suffix", "OPENWIKI_LANGSMITH_API_KEY;rm -rf"],
    ["a non-string value", 42],
    ["an empty string", ""],
  ])("rejects %s", (_label, value) => {
    expect(sanitizeLangSmithApiKeyEnv(value)).toBeUndefined();
  });
});

describe("read/write round-trip", () => {
  test("writes only openwiki/.langsmith.json and reads it back", async () => {
    const root = await createTempRepo();
    const config = {
      workspaces: [
        {
          apiBaseUrl: "https://eu.api.smith.langchain.com",
          apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY",
          projects: [{ name: "prod" }],
        },
      ],
    };

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
