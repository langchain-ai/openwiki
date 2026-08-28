import { describe, expect, test } from "vitest";
import {
  createRepositoryPagePrompt,
  createRepositoryPlannerPrompt,
  type RepositoryPageWorkerJob,
} from "../../src/agent/repository-prompts.ts";
import type { ActiveBeginView } from "../../src/generation/repository-run.ts";

/**
 * Builds a complete active planning view with focused per-test overrides.
 *
 * @param overrides - Active-view fields replaced for one assertion.
 * @returns Complete native repository planning view.
 */
function planningView(
  overrides: Partial<ActiveBeginView> = {},
): ActiveBeginView {
  return {
    status: "active",
    runId: "00000000-0000-4000-8000-000000000001",
    root: "/repo",
    mode: "update",
    language: "en",
    languageChanged: false,
    phase: "planning",
    resumed: false,
    lastUpdate: null,
    changedPaths: ["src/auth.ts"],
    pageUpdateWindows: [
      {
        baseGitHead: "abc123",
        pages: ["/openwiki/auth.md"],
        changedPaths: ["src/auth.ts"],
        fullReview: false,
      },
    ],
    claimIssues: [
      {
        page: "/openwiki/auth.md",
        kind: "stale",
        claimId: "claim_auth",
        resources: ["repo://src/auth.ts"],
      },
    ],
    completedPages: 0,
    wikiGoal: "Prioritize operator safety.",
    ...overrides,
  };
}

/**
 * Builds one complete page-worker job with relevant global instructions.
 *
 * @param overrides - Job fields replaced for one assertion.
 * @returns Complete page-worker context.
 */
function pageJob(
  overrides: Partial<RepositoryPageWorkerJob> = {},
): RepositoryPageWorkerJob {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    path: "/openwiki/auth.md",
    title: "Authentication",
    purpose: "Explain authentication boundaries.",
    seedPaths: ["src/auth.ts"],
    relatedPages: ["/openwiki/operations.md"],
    instructions: ["Emphasize token rotation."],
    status: "pending",
    mode: "update",
    existing: true,
    existingClaims: [
      {
        id: "claim_auth",
        statement: "Authentication uses rotating tokens.",
        evidence: ["repo://src/auth.ts"],
      },
    ],
    ...overrides,
  };
}

describe("repository worker prompts", () => {
  test("preserves actual user and connector planning context", () => {
    const prompt = createRepositoryPlannerPrompt(
      planningView(),
      "User: focus on auth. Connector: trace production incidents.",
    );

    expect(prompt).toContain(
      "User: focus on auth. Connector: trace production incidents.",
    );
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("Baseline abc123");
    expect(prompt).toContain("/openwiki/auth.md");
    expect(prompt).toContain("inside its own committed update window");
    expect(prompt).toContain("claim_auth (stale)");
    expect(prompt).toContain("Prioritize operator safety.");
    expect(prompt).toContain("instructions array");
    expect(prompt).toContain("Use hierarchical paths");
    expect(prompt).toContain("Populate relatedPages");
    expect(prompt).toContain("trace representative end-to-end control");
    expect(prompt).toContain("focused tests and neighboring");
    expect(prompt).not.toContain("force flag");
  });

  test("renders unknown baselines as explicit full-review windows", () => {
    const prompt = createRepositoryPlannerPrompt(
      planningView({
        pageUpdateWindows: [
          {
            pages: ["/openwiki/legacy.md"],
            changedPaths: [],
            fullReview: true,
          },
        ],
      }),
    );

    expect(prompt).toContain("Baseline unknown (full review required)");
    expect(prompt).toContain("Pages: /openwiki/legacy.md");
    expect(prompt).toContain("Changed paths: (none)");
  });

  test("propagates page-specific instructions and complete existing Claims", () => {
    const prompt = createRepositoryPagePrompt(
      pageJob(),
      [pageJob(), pageJob({ path: "/openwiki/operations.md" })],
      "en",
    );

    expect(prompt).toContain("You own exactly /openwiki/auth.md");
    expect(prompt).toContain("Emphasize token rotation.");
    expect(prompt).toContain("claim_auth");
    expect(prompt).toContain("repo://src/auth.ts");
    expect(prompt).toContain("Write only /openwiki/auth.md");
    expect(prompt).toContain("COMPLETE intended material Claim set");
    expect(prompt).toContain("same Claim id and statement verbatim");
    expect(prompt).toContain(
      "stale or unresolved marker as a requirement to recheck",
    );
    expect(prompt).toContain(
      "final page body and complete submitted Claim set must agree",
    );
    expect(prompt).toContain("repo://src/agent/index.ts");
    expect(prompt).toMatch(
      /a bare path such\s+as src\/agent\/index\.ts is invalid/u,
    );
    expect(prompt).toContain("callers,");
    expect(prompt).toContain(
      "Do not turn the page into a source-file inventory",
    );
    expect(prompt).not.toContain("execute");
  });

  test("provides the complete planned map only to quickstart", () => {
    const allPages = [
      pageJob({ path: "/openwiki/quickstart.md", title: "Quickstart" }),
      pageJob({ path: "/openwiki/auth.md" }),
    ];

    expect(createRepositoryPagePrompt(allPages[0], allPages, "en")).toContain(
      "The complete planned page map is:",
    );
    expect(
      createRepositoryPagePrompt(allPages[1], allPages, "en"),
    ).not.toContain("The complete planned page map is:");
  });
});
