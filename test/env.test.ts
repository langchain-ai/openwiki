import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CREDENTIAL_DIAGNOSTIC_ENV_KEYS,
  formatEnv,
  getCredentialDiagnostics,
  MANAGED_ENV_KEYS,
  parseEnv,
} from "../src/env.ts";
import {
  AZURE_OPENAI_API_KEY_ENV_KEY,
  AZURE_OPENAI_API_VERSION_ENV_KEY,
  AZURE_OPENAI_ENDPOINT_ENV_KEY,
  AZURE_OPENAI_USE_AD_TOKEN_ENV_KEY,
} from "../src/constants.ts";

describe("parseEnv", () => {
  test("parses simple KEY=value lines", () => {
    expect(parseEnv("OPENWIKI_PROVIDER=anthropic\n")).toEqual({
      OPENWIKI_PROVIDER: "anthropic",
    });
  });

  test("skips blank lines and comments", () => {
    const content = ["# a comment", "", "OPENAI_API_KEY=abc", "   "].join("\n");

    expect(parseEnv(content)).toEqual({ OPENAI_API_KEY: "abc" });
  });

  test("ignores lines with no '=' or an empty key", () => {
    expect(parseEnv("noequalshere\n=value\n")).toEqual({});
  });

  test("rejects keys that are not UPPER_SNAKE_CASE", () => {
    expect(parseEnv("lowercase=x\nMixed_Case=y\nOK_KEY=z\n")).toEqual({
      OK_KEY: "z",
    });
  });

  test("unquotes and unescapes double-quoted values", () => {
    expect(parseEnv('ANTHROPIC_BASE_URL="https://a.example/v1"\n')).toEqual({
      ANTHROPIC_BASE_URL: "https://a.example/v1",
    });
    expect(parseEnv('OPENAI_API_KEY="line1\\nline2"\n')).toEqual({
      OPENAI_API_KEY: "line1\nline2",
    });
    expect(parseEnv('OPENAI_API_KEY="a\\"b\\\\c"\n')).toEqual({
      OPENAI_API_KEY: 'a"b\\c',
    });
  });

  test("leaves unquoted values as-is", () => {
    expect(parseEnv("OPENWIKI_MODEL_ID=gpt-5.5\n")).toEqual({
      OPENWIKI_MODEL_ID: "gpt-5.5",
    });
  });
});

describe("formatEnv", () => {
  test("quotes and escapes values, terminating with a newline", () => {
    expect(formatEnv({ OPENAI_API_KEY: "abc" })).toBe('OPENAI_API_KEY="abc"\n');
    expect(formatEnv({ OPENAI_API_KEY: 'a"b\\c\nd' })).toBe(
      'OPENAI_API_KEY="a\\"b\\\\c\\nd"\n',
    );
  });

  test("orders managed keys first, then unknown keys sorted alphabetically", () => {
    const formatted = formatEnv({
      ZZZ_CUSTOM: "z",
      AAA_CUSTOM: "a",
      OPENWIKI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "k",
    });
    const keys = formatted
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("=")));

    // Managed keys keep their MANAGED_ENV_KEYS relative order (ANTHROPIC before
    // PROVIDER), and the two unknown keys follow, sorted.
    expect(keys).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENWIKI_PROVIDER",
      "AAA_CUSTOM",
      "ZZZ_CUSTOM",
    ]);
  });
});

describe("parseEnv <-> formatEnv round-trip", () => {
  test("values survive a format -> parse round-trip", () => {
    const original = {
      OPENAI_API_KEY: 'weird "value" with\nnewline and \\ backslash',
      ANTHROPIC_BASE_URL: "https://gateway.example/anthropic",
      OPENWIKI_MODEL_ID: "claude-opus-4-8",
    };

    expect(parseEnv(formatEnv(original))).toEqual(original);
  });
});

describe("azure env keys", () => {
  const AZURE_KEYS = [
    AZURE_OPENAI_API_KEY_ENV_KEY,
    AZURE_OPENAI_ENDPOINT_ENV_KEY,
    AZURE_OPENAI_API_VERSION_ENV_KEY,
    AZURE_OPENAI_USE_AD_TOKEN_ENV_KEY,
  ];

  test("are managed and surfaced in credential diagnostics", () => {
    for (const key of AZURE_KEYS) {
      expect(MANAGED_ENV_KEYS).toContain(key);
      expect(CREDENTIAL_DIAGNOSTIC_ENV_KEYS).toContain(key);
    }
  });

  test("survive a format -> parse round-trip", () => {
    const original = {
      [AZURE_OPENAI_ENDPOINT_ENV_KEY]: "https://foobar.openai.azure.com/",
      [AZURE_OPENAI_API_VERSION_ENV_KEY]: "2024-12-01-preview",
      [AZURE_OPENAI_API_KEY_ENV_KEY]: "super-secret-key",
      [AZURE_OPENAI_USE_AD_TOKEN_ENV_KEY]: "true",
    };

    expect(parseEnv(formatEnv(original))).toEqual(original);
  });
});

describe("azure credential diagnostics masking", () => {
  const originalValues: Record<string, string | undefined> = {};
  const AZURE_KEYS = [
    AZURE_OPENAI_API_KEY_ENV_KEY,
    AZURE_OPENAI_ENDPOINT_ENV_KEY,
    AZURE_OPENAI_API_VERSION_ENV_KEY,
    AZURE_OPENAI_USE_AD_TOKEN_ENV_KEY,
  ];

  beforeEach(() => {
    for (const key of AZURE_KEYS) {
      originalValues[key] = process.env[key];
    }
    process.env[AZURE_OPENAI_ENDPOINT_ENV_KEY] =
      "https://foobar.openai.azure.com/";
    process.env[AZURE_OPENAI_API_VERSION_ENV_KEY] = "2024-12-01-preview";
    process.env[AZURE_OPENAI_USE_AD_TOKEN_ENV_KEY] = "true";
    process.env[AZURE_OPENAI_API_KEY_ENV_KEY] = "super-secret-azure-key-12345";
  });

  afterEach(() => {
    for (const key of AZURE_KEYS) {
      if (originalValues[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValues[key];
      }
    }
  });

  test("shows endpoint, api version, and the AD-token flag in the clear", async () => {
    const diagnostics = await getCredentialDiagnostics();
    const byKey = new Map(diagnostics.map((d) => [d.key, d]));

    expect(byKey.get(AZURE_OPENAI_ENDPOINT_ENV_KEY)?.preview).toBe(
      JSON.stringify("https://foobar.openai.azure.com/"),
    );
    expect(byKey.get(AZURE_OPENAI_API_VERSION_ENV_KEY)?.preview).toBe(
      JSON.stringify("2024-12-01-preview"),
    );
    expect(byKey.get(AZURE_OPENAI_USE_AD_TOKEN_ENV_KEY)?.preview).toBe(
      JSON.stringify("true"),
    );
  });

  test("masks the API key", async () => {
    const diagnostics = await getCredentialDiagnostics();
    const keyDiagnostic = diagnostics.find(
      (d) => d.key === AZURE_OPENAI_API_KEY_ENV_KEY,
    );

    expect(keyDiagnostic).toBeDefined();
    expect(keyDiagnostic?.preview).not.toContain("super-secret-azure-key");
    // Non-secret values render as JSON.stringify of the raw value; the key must
    // not, so it is neither the raw value nor its plain JSON form.
    expect(keyDiagnostic?.preview).not.toBe(
      JSON.stringify("super-secret-azure-key-12345"),
    );
  });
});
