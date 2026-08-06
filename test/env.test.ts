import { describe, expect, test } from "vitest";
import { formatEnv, MANAGED_ENV_KEYS, parseEnv } from "../src/env.ts";

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

  test("unquotes and unescapes carriage returns in double-quoted values", () => {
    expect(parseEnv('OPENAI_API_KEY="line1\\rline2"\n')).toEqual({
      OPENAI_API_KEY: "line1\rline2",
    });
    expect(parseEnv('OPENAI_API_KEY="line1\\r\\nline2"\n')).toEqual({
      OPENAI_API_KEY: "line1\r\nline2",
    });
  });

  test("handles export-prefixed lines", () => {
    expect(parseEnv("export OPENAI_API_KEY=sk-abc\n")).toEqual({
      OPENAI_API_KEY: "sk-abc",
    });
  });

  test("handles export-prefixed lines with double-quoted values", () => {
    expect(
      parseEnv('export ANTHROPIC_BASE_URL="https://api.anthropic.com"\n'),
    ).toEqual({
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    });
  });

  test("handles export-prefixed lines alongside regular lines", () => {
    const content = [
      "export OPENAI_API_KEY=sk-abc",
      "ANTHROPIC_API_KEY=sk-def",
    ].join("\n");
    expect(parseEnv(content)).toEqual({
      OPENAI_API_KEY: "sk-abc",
      ANTHROPIC_API_KEY: "sk-def",
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

  test("escapes carriage returns in values", () => {
    expect(formatEnv({ OPENAI_API_KEY: "line1\rline2" })).toBe(
      'OPENAI_API_KEY="line1\\rline2"\n',
    );
    expect(formatEnv({ OPENAI_API_KEY: "line1\r\nline2" })).toBe(
      'OPENAI_API_KEY="line1\\r\\nline2"\n',
    );
  });

  test("orders managed keys first, then unknown keys sorted alphabetically", () => {
    const formatted = formatEnv({
      ZZZ_CUSTOM: "z",
      AAA_CUSTOM: "a",
      NEBIUS_API_KEY: "n",
      OPENWIKI_PROVIDER_RETRY_ATTEMPTS: "3",
      OPENWIKI_PROVIDER: "anthropic",
      GOOGLE_CLOUD_PROJECT: "proj",
      ANTHROPIC_API_KEY: "k",
    });
    const keys = formatted
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("=")));

    // Managed keys keep their MANAGED_ENV_KEYS relative order (ANTHROPIC before
    // GOOGLE_CLOUD_PROJECT before PROVIDER), and the two unknown keys follow,
    // sorted.
    expect(keys).toEqual([
      "NEBIUS_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_CLOUD_PROJECT",
      "OPENWIKI_PROVIDER",
      "OPENWIKI_PROVIDER_RETRY_ATTEMPTS",
      "AAA_CUSTOM",
      "ZZZ_CUSTOM",
    ]);
  });
});

describe("MANAGED_ENV_KEYS", () => {
  test("manages the Google Cloud settings for the gemini-enterprise provider", () => {
    expect(MANAGED_ENV_KEYS).toContain("GOOGLE_CLOUD_PROJECT");
    expect(MANAGED_ENV_KEYS).toContain("GOOGLE_CLOUD_LOCATION");
    expect(MANAGED_ENV_KEYS).toContain("GOOGLE_APPLICATION_CREDENTIALS");
  });

  test("manages the GEMINI_API_KEY for the gemini (AI Studio) provider", () => {
    expect(MANAGED_ENV_KEYS).toContain("GEMINI_API_KEY");
  });

  test("manages hosted OpenAI-compatible provider base URLs", () => {
    expect(MANAGED_ENV_KEYS).toContain("BASETEN_BASE_URL");
    expect(MANAGED_ENV_KEYS).toContain("FIREWORKS_BASE_URL");
    expect(MANAGED_ENV_KEYS).toContain("NVIDIA_BASE_URL");
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

  test("carriage returns survive a format -> parse round-trip", () => {
    const original = {
      OPENAI_API_KEY: "value with\r carriage return",
      ANTHROPIC_BASE_URL: "value with\r\n crlf pair",
    };

    expect(parseEnv(formatEnv(original))).toEqual(original);
  });
});
