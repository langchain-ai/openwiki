import { describe, expect, test } from "vitest";
import { formatEnvironmentDebugValue } from "../../src/agent/index.ts";
import {
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
} from "../../src/config/constants.ts";

// formatEnvironmentDebugValue feeds the --debug env dump, which can end up in
// pasted bug reports. redaction.test.ts covers the AWS/secret-key masking; the
// cases below cover the non-secret classification branches and the URL
// scrubbing helper, verifying that low-sensitivity values stay legible while a
// URL's credentials/query/fragment are stripped.

describe("formatEnvironmentDebugValue – non-secret classification", () => {
  test("reports an unset variable rather than printing undefined", () => {
    expect(formatEnvironmentDebugValue("ANY_KEY", undefined)).toBe("unset");
  });

  test("prints low-cardinality config values verbatim for debuggability", () => {
    // Model/provider selectors are not secret and are the most useful thing to
    // see in a debug dump, so they are echoed as an exact quoted value.
    expect(
      formatEnvironmentDebugValue(
        OPENWIKI_MODEL_ID_ENV_KEY,
        "claude-haiku-4-5",
      ),
    ).toBe('set(value="claude-haiku-4-5")');
    expect(
      formatEnvironmentDebugValue(OPENWIKI_PROVIDER_ENV_KEY, "anthropic"),
    ).toBe('set(value="anthropic")');
  });

  test("a short generic value is reported by length only", () => {
    // Unknown keys with a <=10 char value get length only (no preview) so a
    // short secret in an unrecognized key is not partially leaked.
    expect(formatEnvironmentDebugValue("SOME_UNKNOWN_KEY", "short")).toBe(
      "set(length=5)",
    );
  });

  test("a long generic value is previewed with head and tail only", () => {
    const value = "abcdefghijklmnop"; // 16 chars, over the 10-char threshold
    const result = formatEnvironmentDebugValue("SOME_UNKNOWN_KEY", value);

    expect(result).toBe('set(length=16, preview="abcdef...mnop")');
    // The middle of the value must never appear in full.
    expect(result).not.toContain(value);
  });
});

describe("formatEnvironmentDebugValue – URL-typed keys", () => {
  test("a plain URL is echoed with no redaction suffix", () => {
    // LANGCHAIN_ENDPOINT routes through the URL formatter; a clean URL has
    // nothing to redact.
    expect(
      formatEnvironmentDebugValue(
        "LANGCHAIN_ENDPOINT",
        "https://api.example.com/v1",
      ),
    ).toBe('set(url="https://api.example.com/v1")');
  });

  test("credentials, query, and fragment are stripped from a URL value", () => {
    const result = formatEnvironmentDebugValue(
      "LANGCHAIN_ENDPOINT",
      "https://user:pass@api.example.com/v1?token=abc#frag",
    );

    expect(result).toContain("redacted=auth+query+hash");
    // None of the sensitive URL parts survive the scrub.
    for (const leaked of ["user", "pass", "token=abc", "frag"]) {
      expect(result).not.toContain(leaked);
    }
  });

  test("a URL-typed key holding a non-URL value falls back to a length preview", () => {
    // If a base-URL env var is misconfigured with a non-URL string, new URL()
    // throws and the formatter degrades to the generic preview shape instead
    // of crashing the debug dump.
    const result = formatEnvironmentDebugValue(
      "LANGCHAIN_ENDPOINT",
      "not a url value at all",
    );

    expect(result).toMatch(/^set\(length=\d+, preview=/u);
  });
});
