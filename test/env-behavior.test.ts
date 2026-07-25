import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ANTHROPIC_API_KEY_ENV_KEY,
  ANTHROPIC_BASE_URL_ENV_KEY,
  BASETEN_BASE_URL_ENV_KEY,
  FIREWORKS_BASE_URL_ENV_KEY,
  NVIDIA_BASE_URL_ENV_KEY,
  OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
  OPENAI_API_KEY_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
} from "../src/constants.ts";

// `loadOpenWikiEnv`, `saveOpenWikiEnv`, and `getCredentialDiagnostics` all read
// from / write to `~/.openwiki/.env`, and `src/env.ts` resolves that path from
// `os.homedir()` **at module load time** (`openWikiEnvPath` is a module-level
// const). A static `import` of `../src/env.ts` would therefore bind the path
// to the developer's real home before any hook can point HOME elsewhere — and
// every save in this file would overwrite the developer's real credentials
// with test fixtures.
//
// So, like `test/onboarding.test.ts`, this file must reset the module registry
// and set HOME **before** dynamically importing the module under test. That
// way each test gets a module instance whose paths are bound to a throwaway
// temp directory, keeping these tests fully isolated from the developer's
// real credentials and machine.
//
// The existing `test/env.test.ts` covers the pure `parseEnv`/`formatEnv`
// serializers. This file covers the runtime behavior of the three functions
// above — the deprecation-dropping, source resolution, file permissions, and
// secret masking — which previously had no coverage.

type EnvModule = typeof import("../src/env.ts");

const KEYS_UNDER_TEST = [
  ANTHROPIC_API_KEY_ENV_KEY,
  ANTHROPIC_BASE_URL_ENV_KEY,
  BASETEN_BASE_URL_ENV_KEY,
  FIREWORKS_BASE_URL_ENV_KEY,
  NVIDIA_BASE_URL_ENV_KEY,
  OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
  OPENAI_API_KEY_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  // Deprecated / recently un-deprecated OpenAI keys. Cleared in each hook so the
  // developer's ambient shell (which may export OPENAI_BASE_URL) cannot leak
  // into these tests, and a loaded value cannot leak back out to other tests.
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
] as const;

let originalHome: string | undefined;
let tempHome: string;
let env: EnvModule;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(path.join(tmpdir(), "openwiki-env-behavior-"));

  // Order matters: HOME must point at the temp directory before the module
  // evaluates, because `openWikiEnvPath` is computed from `os.homedir()` when
  // `src/env.ts` first loads.
  vi.resetModules();
  process.env.HOME = tempHome;
  env = await import("../src/env.ts");

  for (const key of KEYS_UNDER_TEST) {
    delete process.env[key];
  }
});

afterEach(async () => {
  vi.resetModules();

  for (const key of KEYS_UNDER_TEST) {
    delete process.env[key];
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  await rm(tempHome, { recursive: true, force: true });
});

describe("test isolation", () => {
  test("resolves the env file inside the test HOME, never the real home", () => {
    // Regression guard: if `../src/env.ts` is ever imported statically again
    // (binding `os.homedir()` before the HOME swap), this fails loudly instead
    // of letting the suite overwrite the developer's real ~/.openwiki/.env.
    expect(env.openWikiEnvPath.startsWith(tempHome + path.sep)).toBe(true);
  });
});

describe("loadOpenWikiEnv", () => {
  test("loads a saved managed key into process.env", async () => {
    await env.saveOpenWikiEnv({ [OPENROUTER_API_KEY_ENV_KEY]: "sk-or-test" });

    delete process.env[OPENROUTER_API_KEY_ENV_KEY];

    await env.loadOpenWikiEnv();

    expect(process.env[OPENROUTER_API_KEY_ENV_KEY]).toBe("sk-or-test");
  });

  test("does not overwrite a key already present in process.env", async () => {
    await env.saveOpenWikiEnv({ [OPENROUTER_API_KEY_ENV_KEY]: "from-file" });

    process.env[OPENROUTER_API_KEY_ENV_KEY] = "from-process-env";

    await env.loadOpenWikiEnv();

    expect(process.env[OPENROUTER_API_KEY_ENV_KEY]).toBe("from-process-env");
  });

  test("loads OPENAI_BASE_URL but still drops the other deprecated OpenAI keys", async () => {
    // OPENAI_BASE_URL was un-deprecated (PR #90): it is now loaded from
    // ~/.openwiki/.env like any other key, so proxy/gateway setups survive.
    // OPENAI_ORG_ID and OPENAI_PROJECT remain deprecated and are still dropped.
    await mkdir(path.dirname(env.openWikiEnvPath), { recursive: true });
    await writeFile(
      env.openWikiEnvPath,
      [
        "OPENAI_BASE_URL=https://gateway.example.com/v1",
        "OPENAI_ORG_ID=org-123",
        "OPENAI_PROJECT=proj-456",
        `${OPENAI_API_KEY_ENV_KEY}=sk-kept`,
      ].join("\n") + "\n",
      "utf8",
    );

    await env.loadOpenWikiEnv();

    expect(process.env.OPENAI_BASE_URL).toBe("https://gateway.example.com/v1");
    expect(process.env.OPENAI_ORG_ID).toBeUndefined();
    expect(process.env.OPENAI_PROJECT).toBeUndefined();
    expect(process.env[OPENAI_API_KEY_ENV_KEY]).toBe("sk-kept");
  });
});

describe("saveOpenWikiEnv", () => {
  test("persists a value that loadOpenWikiEnv can round-trip", async () => {
    await env.saveOpenWikiEnv({
      [OPENWIKI_PROVIDER_ENV_KEY]: "openrouter",
      [OPENROUTER_API_KEY_ENV_KEY]: "sk-or-roundtrip",
    });

    delete process.env[OPENWIKI_PROVIDER_ENV_KEY];
    delete process.env[OPENROUTER_API_KEY_ENV_KEY];

    await env.loadOpenWikiEnv();

    expect(process.env[OPENWIKI_PROVIDER_ENV_KEY]).toBe("openrouter");
    expect(process.env[OPENROUTER_API_KEY_ENV_KEY]).toBe("sk-or-roundtrip");
  });

  test("writes the env file with 0600 permissions", async () => {
    await env.saveOpenWikiEnv({ [OPENAI_API_KEY_ENV_KEY]: "sk-test" });

    const mode = (await stat(env.openWikiEnvPath)).mode & 0o777;

    // Owner read/write only; no group/other bits.
    expect(mode & 0o077).toBe(0);
    expect(mode & 0o600).toBe(0o600);
  });

  test("strips deprecated keys from the persisted file", async () => {
    // A deprecated key written by an older OpenWiki version must not survive a
    // subsequent save, so stale deprecated values can't linger in the file.
    await mkdir(path.dirname(env.openWikiEnvPath), { recursive: true });
    await writeFile(env.openWikiEnvPath, "OPENAI_ORG_ID=stale-org\n", "utf8");

    await env.saveOpenWikiEnv({ [OPENAI_API_KEY_ENV_KEY]: "sk-fresh" });

    const contents = await readFile(env.openWikiEnvPath, "utf8");

    expect(contents).not.toContain("OPENAI_ORG_ID");
    expect(contents).toContain("OPENAI_API_KEY=");
  });

  test("seeds process.env with the saved value immediately", async () => {
    await env.saveOpenWikiEnv({ [OPENAI_API_KEY_ENV_KEY]: "sk-immediate" });

    expect(process.env[OPENAI_API_KEY_ENV_KEY]).toBe("sk-immediate");
  });

  test("does not mask a shell var in process.env, but still writes the file", async () => {
    // A shell export present before any load/save wins at runtime, so the save
    // must not overwrite it in-process; the saved value is only the fallback.
    process.env[OPENROUTER_API_KEY_ENV_KEY] = "from-shell";

    await env.saveOpenWikiEnv({ [OPENROUTER_API_KEY_ENV_KEY]: "from-wizard" });

    expect(process.env[OPENROUTER_API_KEY_ENV_KEY]).toBe("from-shell");

    const contents = await readFile(env.openWikiEnvPath, "utf8");
    expect(contents).toContain('OPENROUTER_API_KEY="from-wizard"');
  });

  test('drops an empty value instead of persisting KEY=""', async () => {
    // Skipping an optional key (empty value) must clear it, not save KEY=""
    // (which would later read back as configured).
    await env.saveOpenWikiEnv({ [OPENROUTER_API_KEY_ENV_KEY]: "sk-real" });
    await env.saveOpenWikiEnv({ [OPENROUTER_API_KEY_ENV_KEY]: "" });

    const contents = await readFile(env.openWikiEnvPath, "utf8");
    expect(contents).not.toContain(OPENROUTER_API_KEY_ENV_KEY);
    expect(process.env[OPENROUTER_API_KEY_ENV_KEY]).toBeUndefined();
  });

  test("a failed write leaves the existing credentials intact (atomic swap)", async () => {
    // Seed the file with real credentials, then force the content write to fail
    // the way a full disk would (truncate the target, then error). The atomic
    // temp-file + rename must leave the original ~/.openwiki/.env untouched
    // rather than truncating it and wiping every saved token.
    await mkdir(path.dirname(env.openWikiEnvPath), { recursive: true });
    const original =
      `${OPENAI_API_KEY_ENV_KEY}=sk-original\n` +
      `${OPENROUTER_API_KEY_ENV_KEY}="or-original"\n`;
    await writeFile(env.openWikiEnvPath, original, "utf8");

    // Re-import env against a writeFile that emulates O_TRUNC-then-ENOSPC:
    // it truncates whatever path it is handed, then throws. mkdir/readFile/
    // chmod/rename stay real.
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      return {
        ...actual,
        default: actual,
        writeFile: vi.fn(
          async (file: Parameters<typeof actual.writeFile>[0]) => {
            // Open-for-write truncates before the write fails, exactly as a real
            // disk-full error would.
            await actual.writeFile(file, "");
            const error: NodeJS.ErrnoException = new Error(
              "ENOSPC: no space left on device",
            );
            error.code = "ENOSPC";
            throw error;
          },
        ),
      };
    });

    try {
      const failingEnv = await import("../src/env.ts");
      await expect(
        failingEnv.saveOpenWikiEnv({ [OPENAI_API_KEY_ENV_KEY]: "sk-new" }),
      ).rejects.toThrow(/ENOSPC/);
    } finally {
      vi.doUnmock("node:fs/promises");
    }

    // The original file survives: the failed write hit only the temp file and
    // the rename that would have replaced it never ran.
    await expect(readFile(env.openWikiEnvPath, "utf8")).resolves.toBe(original);
  });
});

describe("getShellEnvValue", () => {
  test("reflects the pre-load shell snapshot, stable across later writes", async () => {
    process.env[OPENAI_API_KEY_ENV_KEY] = "shell-key";

    // The first load/save captures the snapshot.
    await env.loadOpenWikiEnv();

    expect(env.getShellEnvValue(OPENAI_API_KEY_ENV_KEY)).toBe("shell-key");

    // A key the shell did not set is not in the snapshot, and saving it later
    // does not retroactively add it (the snapshot is taken once, up front).
    await env.saveOpenWikiEnv({ [OPENROUTER_API_KEY_ENV_KEY]: "saved" });

    expect(env.getShellEnvValue(OPENROUTER_API_KEY_ENV_KEY)).toBeUndefined();
  });

  test("is undefined for a key absent from the shell at startup", async () => {
    await env.loadOpenWikiEnv();

    expect(env.getShellEnvValue(OPENAI_API_KEY_ENV_KEY)).toBeUndefined();
  });
});

describe("getSavedEnvValue", () => {
  test("returns the saved file value, not a shadowing shell value", async () => {
    // The shell shadows the key at runtime...
    process.env[OPENROUTER_API_KEY_ENV_KEY] = "from-shell";
    // ...but a different value is saved in the file.
    await mkdir(path.dirname(env.openWikiEnvPath), { recursive: true });
    await writeFile(
      env.openWikiEnvPath,
      `${OPENROUTER_API_KEY_ENV_KEY}="from-file"\n`,
      "utf8",
    );

    await env.loadOpenWikiEnv();

    // process.env keeps the shell value (shell wins)...
    expect(process.env[OPENROUTER_API_KEY_ENV_KEY]).toBe("from-shell");
    // ...but the saved snapshot reflects the file, so the wizard seeds config.
    expect(env.getSavedEnvValue(OPENROUTER_API_KEY_ENV_KEY)).toBe("from-file");
  });

  test("is undefined for a key absent from the saved file", async () => {
    await env.loadOpenWikiEnv();

    expect(env.getSavedEnvValue(OPENROUTER_API_KEY_ENV_KEY)).toBeUndefined();
  });
});

describe("getCredentialDiagnostics", () => {
  test("includes the provider and each credential key in display order", async () => {
    const diagnostics = await env.getCredentialDiagnostics();
    const keys = diagnostics.map((entry) => entry.key);

    expect(keys[0]).toBe(OPENWIKI_PROVIDER_ENV_KEY);
    expect(keys).toContain(OPENAI_API_KEY_ENV_KEY);
    expect(keys).toContain(ANTHROPIC_API_KEY_ENV_KEY);
    expect(keys).toContain(BASETEN_BASE_URL_ENV_KEY);
    expect(keys).toContain(FIREWORKS_BASE_URL_ENV_KEY);
    expect(keys).toContain(NVIDIA_BASE_URL_ENV_KEY);
    expect(keys).toContain(OPENROUTER_API_KEY_ENV_KEY);
    // Keys are unique.
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("reports an unset key as unset with no warnings", async () => {
    await rm(env.openWikiEnvPath, { force: true });

    const diagnostics = await env.getCredentialDiagnostics();
    const entry = diagnostics.find(
      (item) => item.key === OPENROUTER_API_KEY_ENV_KEY,
    );

    expect(entry?.source).toBe("unset");
    expect(entry?.length).toBeNull();
    expect(entry?.preview).toBe("<unset>");
    expect(entry?.warnings).toEqual([]);
  });

  test("masks a secret value rather than echoing it", async () => {
    await env.saveOpenWikiEnv({ [OPENAI_API_KEY_ENV_KEY]: "sk-secret-12345" });

    const diagnostics = await env.getCredentialDiagnostics();
    const entry = diagnostics.find(
      (item) => item.key === OPENAI_API_KEY_ENV_KEY,
    );

    expect(entry?.preview).not.toContain("sk-secret-12345");
    expect(entry?.length).toBe("sk-secret-12345".length);
  });

  test("surfaces non-secret base URLs verbatim, not masked", async () => {
    await env.saveOpenWikiEnv({
      [ANTHROPIC_BASE_URL_ENV_KEY]: "https://gateway.example.com/anthropic",
      [BASETEN_BASE_URL_ENV_KEY]: "https://gateway.example.com/baseten/v1",
    });

    const diagnostics = await env.getCredentialDiagnostics();
    const anthropicEntry = diagnostics.find(
      (item) => item.key === ANTHROPIC_BASE_URL_ENV_KEY,
    );
    const basetenEntry = diagnostics.find(
      (item) => item.key === BASETEN_BASE_URL_ENV_KEY,
    );

    expect(anthropicEntry?.preview).toBe(
      '"https://gateway.example.com/anthropic"',
    );
    expect(basetenEntry?.preview).toBe(
      '"https://gateway.example.com/baseten/v1"',
    );
  });

  test("flags an invalid model ID with a warning", async () => {
    await env.saveOpenWikiEnv({ [OPENWIKI_MODEL_ID_ENV_KEY]: "bad model id" });

    const diagnostics = await env.getCredentialDiagnostics();
    const entry = diagnostics.find(
      (item) => item.key === OPENWIKI_MODEL_ID_ENV_KEY,
    );

    expect(entry?.warnings).toContain("invalid model ID");
  });

  test("flags an invalid provider with a warning", async () => {
    await env.saveOpenWikiEnv({
      [OPENWIKI_PROVIDER_ENV_KEY]: "not-a-provider",
    });

    const diagnostics = await env.getCredentialDiagnostics();
    const entry = diagnostics.find(
      (item) => item.key === OPENWIKI_PROVIDER_ENV_KEY,
    );

    expect(entry?.warnings).toContain("invalid provider");
  });

  test("flags an OpenAI-compatible chat completions endpoint as a base URL warning", async () => {
    await env.saveOpenWikiEnv({
      [OPENAI_COMPATIBLE_BASE_URL_ENV_KEY]:
        "https://gateway.example.com/v1/chat/completions",
    });

    const diagnostics = await env.getCredentialDiagnostics();
    const entry = diagnostics.find(
      (item) => item.key === OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
    );

    expect(entry?.warnings).toContain(
      "use API root URL, not /chat/completions endpoint",
    );
  });

  test("prefers process.env over the file when both are set", async () => {
    await env.saveOpenWikiEnv({ [OPENROUTER_API_KEY_ENV_KEY]: "from-file" });

    // Override process.env after the save seeds it.
    process.env[OPENROUTER_API_KEY_ENV_KEY] = "from-process-env";

    const diagnostics = await env.getCredentialDiagnostics();
    const entry = diagnostics.find(
      (item) => item.key === OPENROUTER_API_KEY_ENV_KEY,
    );

    expect(entry?.source).toBe("process.env over ~/.openwiki/.env");
  });
});
