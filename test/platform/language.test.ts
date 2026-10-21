import { describe, expect, test } from "vitest";
import {
  requireResolvedLanguage,
  getLanguageScript,
  getPrimaryLanguageSubtag,
  isSameWrittenLanguage,
  resolveLanguage,
} from "../../src/platform/language.ts";

describe("resolveLanguage", () => {
  test("canonicalizes recognized BCP-47 codes", () => {
    expect(resolveLanguage("zh-CN")).toEqual({
      kind: "resolved",
      language: "zh-CN",
    });
    expect(resolveLanguage("hi")).toEqual({ kind: "resolved", language: "hi" });
    expect(resolveLanguage("PT-br")).toEqual({
      kind: "resolved",
      language: "pt-BR",
    });
    expect(resolveLanguage("  en-US  ")).toEqual({
      kind: "resolved",
      language: "en-US",
    });
    // A three-letter ISO 639-2 code narrows to its two-letter equivalent.
    expect(resolveLanguage("kor")).toEqual({
      kind: "resolved",
      language: "ko",
    });
  });

  test("reports empty or missing input as absent, never as unrecognized", () => {
    expect(resolveLanguage(undefined)).toEqual({ kind: "absent" });
    expect(resolveLanguage(null)).toEqual({ kind: "absent" });
    expect(resolveLanguage("   ")).toEqual({ kind: "absent" });
  });

  test("rejects malformed tags", () => {
    const result = resolveLanguage("fake-language");

    expect(result.kind).toBe("unrecognized");
    if (result.kind !== "unrecognized") throw new Error("expected rejection");
    expect(result.input).toBe("fake-language");
    expect(result.message).toContain("fake-language");
  });

  test("rejects a language name written out instead of its code", () => {
    // "korean" is a structurally legal 5-8 letter BCP-47 subtag that was never
    // registered, so only the DisplayNames check catches it.
    for (const unknown of ["xx", "english", "Korean", "한국어"]) {
      const result = resolveLanguage(unknown);

      expect(result.kind, unknown).toBe("unrecognized");
    }
  });
});

describe("requireResolvedLanguage", () => {
  test("returns the canonical tag, or undefined when none was requested", () => {
    expect(requireResolvedLanguage("PT-br")).toBe("pt-BR");
    expect(requireResolvedLanguage(undefined)).toBeUndefined();
    expect(requireResolvedLanguage("  ")).toBeUndefined();
  });

  test("throws when an unrecognized value slipped past an entry point", () => {
    // Post-boundary code must never quietly resolve a typo to English; that
    // silent fallback is what persisted the wrong language and wedged the run.
    expect(() => requireResolvedLanguage("Korean")).toThrow("Korean");
  });
});

describe("getPrimaryLanguageSubtag", () => {
  test("compares language variants by their primary subtag", () => {
    expect(getPrimaryLanguageSubtag("en-GB")).toBe("en");
    expect(getPrimaryLanguageSubtag("zh-CN")).toBe("zh");
  });

  test("treats an absent persisted language as English", () => {
    expect(getPrimaryLanguageSubtag(undefined)).toBe("en");
    expect(getPrimaryLanguageSubtag(null)).toBe("en");
  });

  test("preserves malformed persisted values for a safe mismatch", () => {
    expect(getPrimaryLanguageSubtag("not_a_locale")).toBe("not_a_locale");
  });
});

describe("getLanguageScript", () => {
  test("resolves the likely writing script of a language tag", () => {
    expect(getLanguageScript("zh-CN")).toBe("Hans");
    expect(getLanguageScript("zh-TW")).toBe("Hant");
    expect(getLanguageScript("sr")).toBe("Cyrl");
    expect(getLanguageScript("sr-Latn")).toBe("Latn");
    expect(getLanguageScript("en")).toBe("Latn");
  });

  test("treats an absent persisted language as English", () => {
    expect(getLanguageScript(undefined)).toBe("Latn");
    expect(getLanguageScript(null)).toBe("Latn");
  });

  test("preserves malformed persisted values for a safe mismatch", () => {
    expect(getLanguageScript("not_a_locale")).toBe("not_a_locale");
  });
});

describe("isSameWrittenLanguage", () => {
  test("matches a region-only change with the same script", () => {
    expect(isSameWrittenLanguage("en-GB", "en")).toBe(true);
    expect(isSameWrittenLanguage("en", undefined)).toBe(true);
  });

  test("distinguishes script variants sharing a primary subtag", () => {
    expect(isSameWrittenLanguage("zh-TW", "zh-CN")).toBe(false);
    expect(isSameWrittenLanguage("sr-Latn", "sr")).toBe(false);
    expect(isSameWrittenLanguage("az-Arab", "az")).toBe(false);
  });
});
