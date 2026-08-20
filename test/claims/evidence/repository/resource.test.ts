import { describe, expect, test } from "vitest";
import { EvidenceResourceError } from "../../../../src/claims/core/errors.ts";
import {
  formatRepositoryEvidenceResource,
  parseRepositoryEvidenceResource,
  REPOSITORY_EVIDENCE_PREFIX,
} from "../../../../src/claims/evidence/repository/resource.ts";

describe("parseRepositoryEvidenceResource", () => {
  test("parses whole-file and line-range resources", () => {
    expect(parseRepositoryEvidenceResource("repo://src/config.ts")).toEqual({
      path: "src/config.ts",
    });
    expect(
      parseRepositoryEvidenceResource("repo://src/config.ts#L10-L24"),
    ).toEqual({
      path: "src/config.ts",
      range: { startLine: 10, endLine: 24 },
    });
    expect(parseRepositoryEvidenceResource("repo://src/config.ts#L8")).toEqual({
      path: "src/config.ts",
      range: { startLine: 8, endLine: 8 },
    });
  });

  test("decodes escaped path delimiters and canonicalizes separators", () => {
    expect(
      parseRepositoryEvidenceResource("repo://src\\feature%23flags.ts#L2-L4"),
    ).toEqual({
      path: "src/feature#flags.ts",
      range: { startLine: 2, endLine: 4 },
    });
  });

  test("exports the stable repository namespace", () => {
    expect(REPOSITORY_EVIDENCE_PREFIX).toBe("repo://");
  });

  test("formats canonical resources without escaping path separators", () => {
    expect(
      formatRepositoryEvidenceResource({
        path: "src/feature#flags.ts",
        range: { startLine: 2, endLine: 4 },
      }),
    ).toBe("repo://src/feature%23flags.ts#L2-L4");
  });

  test.each([
    { path: "src/../secret.ts" },
    { path: "src\\config.ts" },
    { path: "openwiki/page.md" },
    { path: "src/config.ts", range: { startLine: 0, endLine: 1 } },
    { path: "src/config.ts", range: { startLine: 3, endLine: 2 } },
  ])("rejects non-normalized formatter input %#", (resource) => {
    expect(() => formatRepositoryEvidenceResource(resource)).toThrow(
      EvidenceResourceError,
    );
  });

  test.each([
    "file://src/config.ts",
    "repo://",
    "repo://.",
    "repo://../secret.ts",
    "repo://src/../../secret.ts",
    "repo:///etc/passwd",
    "repo://C%3A%5Csecrets%5Ctoken.ts",
    "repo://.git/config",
    "repo://.GIT/config",
    "repo://openwiki/page.md",
    "repo://OpenWiki/page.md",
    "repo://src/config.ts#",
    "repo://src/config.ts#symbol",
    "repo://src/config.ts#L0-L1",
    "repo://src/config.ts#L3-L2",
    "repo://src/config.ts#L1-L2-L3",
    "repo://src/config.ts#L1#L2",
    "repo://src/%00config.ts",
    "repo://src/config.ts#L1%0A-L2",
    "repo://src/%E0%A4%A.ts",
  ])("rejects unsafe or malformed resource %s", (resource) => {
    expect(() => parseRepositoryEvidenceResource(resource)).toThrow(
      EvidenceResourceError,
    );
  });
});
