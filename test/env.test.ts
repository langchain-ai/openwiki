import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getCredentialDiagnostics,
  loadOpenWikiEnv,
  openWikiEnvPath,
  saveOpenWikiEnv,
} from "../src/env.ts";
import {
  OPENAI_API_KEY_ENV_KEY,
  OPENAI_BASE_URL_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
} from "../src/constants.ts";

// `loadOpenWikiEnv` reads from a fixed `~/.openwiki/.env` path derived from
// `os.homedir()`. Pointing HOME at a throwaway temp directory keeps these
// tests fully isolated from the developer's real credentials and machine.
const ENV_KEYS_UNDER_TEST = [
  OPENAI_API_KEY_ENV_KEY,
  OPENAI_BASE_URL_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
] as const;

let originalHome: string | undefined;
let tempHome: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(path.join(tmpdir(), "openwiki-env-test-"));
  process.env.HOME = tempHome;

  for (const key of ENV_KEYS_UNDER_TEST) {
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ENV_KEYS_UNDER_TEST) {
    delete process.env[key];
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  await rm(tempHome, { recursive: true, force: true });
});

describe("loadOpenWikiEnv — OPENAI_BASE_URL regression (#64)", () => {
  test("no longer drops OPENAI_BASE_URL saved to ~/.openwiki/.env", async () => {
    const proxyUrl = "https://audit-gateway.example.com/v1";

    await saveOpenWikiEnv({ [OPENAI_BASE_URL_ENV_KEY]: proxyUrl });

    const env = await loadOpenWikiEnv();

    // The persisted file must keep the override...
    expect(env[OPENAI_BASE_URL_ENV_KEY]).toBe(proxyUrl);

    // ...and it must be loaded into process.env rather than silently dropped.
    expect(process.env[OPENAI_BASE_URL_ENV_KEY]).toBe(proxyUrl);
  });

  test("does not clobber an OPENAI_BASE_URL already in process.env", async () => {
    const inlineUrl = "https://inline-proxy.example.com/v1";
    const fileUrl = "https://file-proxy.example.com/v1";

    // Save a file value first (this also seeds process.env with fileUrl).
    await saveOpenWikiEnv({ [OPENAI_BASE_URL_ENV_KEY]: fileUrl });

    // Now have the caller override process.env after the save, simulating an
    // explicit `OPENAI_BASE_URL=... openwiki` invocation.
    process.env[OPENAI_BASE_URL_ENV_KEY] = inlineUrl;

    await loadOpenWikiEnv();

    // process.env wins over the file, matching the existing precedence rule.
    expect(process.env[OPENAI_BASE_URL_ENV_KEY]).toBe(inlineUrl);
  });

  test("still drops genuinely deprecated OpenAI keys (OPENAI_ORG_ID, OPENAI_PROJECT)", async () => {
    // Sanity check: only OPENAI_BASE_URL was un-deprecated; the other legacy
    // keys remain ignored so a stale ~/.openwiki/.env can't override behavior.
    const rawEnvFile = [
      `OPENAI_ORG_ID=org-should-be-ignored`,
      `OPENAI_PROJECT=proj-should-be-ignored`,
    ].join("\n");

    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(openWikiEnvPath), { recursive: true });
    await writeFile(openWikiEnvPath, `${rawEnvFile}\n`, "utf8");

    const env = await loadOpenWikiEnv();

    expect(env.OPENAI_ORG_ID).toBe("org-should-be-ignored");
    expect(process.env.OPENAI_ORG_ID).toBeUndefined();
    expect(process.env.OPENAI_PROJECT).toBeUndefined();
  });
});

describe("saveOpenWikiEnv round-trip", () => {
  test("persists and reloads a full provider configuration", async () => {
    await saveOpenWikiEnv({
      [OPENWIKI_PROVIDER_ENV_KEY]: "openai",
      [OPENAI_API_KEY_ENV_KEY]: "sk-test-key",
      [OPENAI_BASE_URL_ENV_KEY]: "https://gateway.example.com/v1",
    });

    // Wipe process.env to simulate a fresh process reading the saved file.
    delete process.env[OPENAI_API_KEY_ENV_KEY];
    delete process.env[OPENAI_BASE_URL_ENV_KEY];

    await loadOpenWikiEnv();

    expect(process.env[OPENAI_API_KEY_ENV_KEY]).toBe("sk-test-key");
    expect(process.env[OPENAI_BASE_URL_ENV_KEY]).toBe(
      "https://gateway.example.com/v1",
    );
  });

  test("writes a 0600 env file", async () => {
    await saveOpenWikiEnv({ [OPENROUTER_API_KEY_ENV_KEY]: "sk-or-..." });

    const stat = await import("node:fs/promises").then((fs) =>
      fs.stat(openWikiEnvPath),
    );
    const mode = stat.mode & 0o777;

    // macOS/Linux: 0600. Be permissive about extra bits on odd filesystems.
    expect(mode & 0o077).toBe(0o000);
    expect(mode & 0o600).toBe(0o600);
  });

  test("treats the file as the source of truth for the saved override", async () => {
    await saveOpenWikiEnv({
      [OPENAI_BASE_URL_ENV_KEY]: "https://saved.example.com/v1",
    });

    const contents = await readFile(openWikiEnvPath, "utf8");
    expect(contents).toContain(
      `${OPENAI_BASE_URL_ENV_KEY}="https://saved.example.com/v1"`,
    );
  });
});

describe("getCredentialDiagnostics", () => {
  test("reports OPENAI_BASE_URL as a configured, non-secret diagnostic", async () => {
    await saveOpenWikiEnv({
      [OPENAI_BASE_URL_ENV_KEY]: "https://proxy.example.com/v1",
    });

    const diagnostics = await getCredentialDiagnostics();
    const openAiBaseUrl = diagnostics.find(
      (entry) => entry.key === OPENAI_BASE_URL_ENV_KEY,
    );

    expect(openAiBaseUrl).toBeDefined();
    // The value is surfaced verbatim (not masked) because a base URL is not a
    // secret, unlike API keys.
    expect(openAiBaseUrl?.preview).toBe('"https://proxy.example.com/v1"');
    // saveOpenWikiEnv mirrors the value into process.env, so the diagnostic
    // correctly reports it as present in both places.
    expect(openAiBaseUrl?.source).toBe("process.env over ~/.openwiki/.env");
  });

  test("reports an unset OPENAI_BASE_URL as unset", async () => {
    // Other tests in this suite write to the shared temp env file; remove it
    // so this assertion observes a genuinely unconfigured state.
    await rm(openWikiEnvPath, { force: true });

    const diagnostics = await getCredentialDiagnostics();
    const openAiBaseUrl = diagnostics.find(
      (entry) => entry.key === OPENAI_BASE_URL_ENV_KEY,
    );

    expect(openAiBaseUrl?.source).toBe("unset");
    expect(openAiBaseUrl?.preview).toBe("<unset>");
  });
});
