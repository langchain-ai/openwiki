import { describe, expect, test } from "vitest";
import {
  getPrimaryLanguageSubtag,
  resolveLanguage,
} from "../../src/platform/language.ts";

describe("resolveLanguage", () => {
  test("canonicalizes recognized BCP-47 codes", () => {
    expect(resolveLanguage("zh-CN")).toEqual({ language: "zh-CN" });
    expect(resolveLanguage("hi")).toEqual({ language: "hi" });
    expect(resolveLanguage("PT-br")).toEqual({ language: "pt-BR" });
    expect(resolveLanguage("  en-US  ")).toEqual({ language: "en-US" });
  });

  test("returns nothing for empty or missing input", () => {
    expect(resolveLanguage(undefined)).toEqual({});
    expect(resolveLanguage(null)).toEqual({});
    expect(resolveLanguage("   ")).toEqual({});
  });

  test("warns and drops malformed tags", () => {
    const result = resolveLanguage("fake-language");

    expect(result.language).toBeUndefined();
    expect(result.warning).toContain("fake-language");
  });

  test("warns and drops structurally valid but unknown codes", () => {
    for (const unknown of ["xx", "english"]) {
      const result = resolveLanguage(unknown);

      expect(result.language, unknown).toBeUndefined();
      expect(result.warning, unknown).toBeTruthy();
    }
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
