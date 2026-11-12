import { describe, expect, test } from "vitest";
import { ClaimSessionError } from "../../../../src/claims/core/errors.ts";
import {
  CLAIMS_DIRECTORY,
  isGroundedWikiPage,
  normalizeClaimsToolPagePath,
  normalizeWikiToolPagePath,
  normalizeWikiPagePath,
  RESERVED_WIKI_FILES,
  toClaimsSidecarRelativePath,
  toRepositoryPagePath,
} from "../../../../src/claims/brains/code/paths.ts";

describe("code-brain claim paths", () => {
  test.each([
    ["openwiki/guides/configuration.md", "/openwiki/guides/configuration.md"],
    ["/openwiki/guides/configuration.md", "/openwiki/guides/configuration.md"],
    ["openwiki\\guides\\configuration.md", "/openwiki/guides/configuration.md"],
    [
      "//openwiki//guides//configuration.md",
      "/openwiki/guides/configuration.md",
    ],
  ])("canonicalizes %s", (input, expected) => {
    expect(normalizeWikiPagePath(input)).toBe(expected);
  });

  test.each([
    ["guides/configuration.md", "/openwiki/guides/configuration.md"],
    ["/guides/configuration.md", "/openwiki/guides/configuration.md"],
    ["openwiki/guides/configuration.md", "/openwiki/guides/configuration.md"],
    ["/openwiki/guides/configuration.md", "/openwiki/guides/configuration.md"],
  ])("canonicalizes model-facing path %s", (input, expected) => {
    expect(normalizeClaimsToolPagePath(input)).toBe(expected);
  });

  test("maps a page to repository and sidecar paths", () => {
    const page = "/openwiki/guides/configuration.md";

    expect(toRepositoryPagePath(page)).toBe("openwiki/guides/configuration.md");
    expect(toClaimsSidecarRelativePath(page)).toBe("guides/configuration.json");
  });

  test.each(["index.md", "/openwiki/INSTRUCTIONS.md"])(
    "canonicalizes structural tool path %s without assigning Claims",
    (page) => {
      const normalized = normalizeWikiToolPagePath(page);
      expect(normalized).toMatch(/^\/openwiki\//u);
      expect(isGroundedWikiPage(normalized)).toBe(false);
    },
  );

  test("recognizes factual Markdown pages", () => {
    expect(isGroundedWikiPage("/openwiki/quickstart.md")).toBe(true);
    expect(isGroundedWikiPage("/openwiki/architecture/overview.md")).toBe(true);
    expect(isGroundedWikiPage("/openwiki/architecture/overview.txt")).toBe(
      false,
    );
    expect(isGroundedWikiPage("/outside/page.md")).toBe(false);
  });

  test.each([
    "/openwiki/index.md",
    "/openwiki/nested/Index.md",
    "/openwiki/log.md",
    "/openwiki/INSTRUCTIONS.md",
    "/openwiki/AGENTS.md",
    "/openwiki/nested/AGENTS.md",
    "/openwiki/.claims/page.md",
    "/openwiki/.CLAIMS/page.md",
    "/openwiki/nested/.claims/page.md",
  ])("excludes structural path %s", (page) => {
    expect(isGroundedWikiPage(page)).toBe(false);
    expect(() => normalizeWikiPagePath(page)).toThrow(ClaimSessionError);
  });

  test.each([
    "quickstart.md",
    "/openwiki",
    "/openwiki/page.txt",
    "/openwiki/../page.md",
    "/openwiki/guides/./page.md",
  ])("rejects invalid or aliased page path %s", (page) => {
    expect(() => normalizeWikiPagePath(page)).toThrow(ClaimSessionError);
  });

  test.each(["../outside.md", "page.txt", "index.md", ".claims/page.md"])(
    "rejects invalid model-facing page path %s",
    (page) => {
      expect(() => normalizeClaimsToolPagePath(page)).toThrow(
        ClaimSessionError,
      );
    },
  );

  test.each(["AGENTS.md", "nested/AGENTS.md", "openwiki\\nested\\AGENTS.md"])(
    "rejects user-owned guide tool path %s",
    (page) => {
      expect(() => normalizeWikiToolPagePath(page)).toThrow(ClaimSessionError);
      expect(() => normalizeClaimsToolPagePath(page)).toThrow(ClaimSessionError);
    },
  );

  test.each(["agents.md", "Agents.md", "nested/agents.md", "nested/Agents.md"])(
    "rejects case-insensitive guide alias %s at mutation boundaries",
    (page) => {
      expect(() => normalizeWikiToolPagePath(page)).toThrow(ClaimSessionError);
      expect(() => normalizeClaimsToolPagePath(page)).toThrow(ClaimSessionError);
      expect(normalizeWikiPagePath(`/openwiki/${page}`)).toBe(`/openwiki/${page}`);
    },
  );

  test.each(["agents.md", "Agents.md", "my-AGENTS.md"])(
    "keeps non-exact guide name %s factual",
    (name) => {
      expect(isGroundedWikiPage(`/openwiki/nested/${name}`)).toBe(true);
      expect(normalizeWikiPagePath(`/openwiki/nested/${name}`)).toBe(
        `/openwiki/nested/${name}`,
      );
    },
  );

  test("exports stable structural names", () => {
    expect(CLAIMS_DIRECTORY).toBe(".claims");
    expect(RESERVED_WIKI_FILES).toContain("index.md");
    expect(RESERVED_WIKI_FILES).toContain("instructions.md");
  });
});
