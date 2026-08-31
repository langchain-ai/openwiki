import { describe, expect, test } from "vitest";
import {
  createRepositoryPagePrompt,
  createRepositoryPlannerPrompt,
  recursionRoleGuidance,
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
    existingClaimCount: 7,
    claimsRequiringAttention: [
      {
        id: "claim_auth",
        statement: "Authentication uses rotating tokens.",
        evidence: ["repo://src/auth.ts"],
        issue: {
          kind: "stale",
          resources: ["repo://src/auth.ts"],
        },
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

  test("propagates only Claims requiring explicit reconciliation", () => {
    const prompt = createRepositoryPagePrompt(
      pageJob(),
      [pageJob(), pageJob({ path: "/openwiki/operations.md" })],
      "en",
    );

    expect(prompt).toContain("You own exactly /openwiki/auth.md");
    expect(prompt).toContain("Emphasize token rotation.");
    expect(prompt).toContain("claim_auth");
    expect(prompt).toContain("repo://src/auth.ts");
    expect(prompt).toContain("currently owns 7 Claim(s)");
    expect(prompt).toContain("Write only /openwiki/auth.md");
    expect(prompt).toContain("only the sparse Claim decisions");
    expect(prompt).toContain("inspect_claims");
    expect(prompt).toContain("retained automatically");
    expect(prompt).toContain(
      "stale or unresolved marker as a requirement to recheck",
    );
    expect(prompt).toContain(
      "final page body and reconciled Claim set must agree",
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

describe("recursion role guidance in repository prompts", () => {
  test("subproject role scopes to one subproject and forbids siblings", () => {
    const guidance = recursionRoleGuidance("subproject");
    expect(guidance).toContain("Monorepo subproject scope");
    expect(guidance).toMatch(/scoped to ONE subproject/);
    expect(guidance).toMatch(/document, read into, or write to sibling/i);

    const planner = createRepositoryPlannerPrompt(
      planningView(),
      undefined,
      "subproject",
    );
    expect(planner).toContain("Monorepo subproject scope");

    const page = createRepositoryPagePrompt(
      pageJob(),
      [pageJob()],
      "en",
      "subproject",
    );
    expect(page).toContain("Monorepo subproject scope");
  });

  test("root role links down and does not deep-document subtrees", () => {
    const guidance = recursionRoleGuidance("root");
    expect(guidance).toContain("Monorepo root scope");
    expect(guidance).toMatch(/link DOWN/);
    expect(guidance).toContain("openwiki/workspaces.md");
    expect(guidance).toMatch(/Do NOT deep-document/);

    const planner = createRepositoryPlannerPrompt(
      planningView(),
      undefined,
      "root",
    );
    expect(planner).toContain("Monorepo root scope");

    const page = createRepositoryPagePrompt(pageJob(), [pageJob()], "en", "root");
    expect(page).toContain("Monorepo root scope");
  });

  test("root role consults sub-wiki quickstarts as read-only reference", () => {
    const guidance = recursionRoleGuidance("root");

    // Directs consulting each sub-wiki entrypoint...
    expect(guidance).toMatch(/CONSULT each subproject's sub-wiki/);
    expect(guidance).toContain("openwiki/quickstart.md");
    // ...enumerated from the workspaces manifest...
    expect(guidance).toContain("openwiki/workspaces.json");
    expect(guidance).toContain("openwiki/workspaces.md");
    // ...for scope/naming/terminology consistency...
    expect(guidance).toMatch(/scope, naming, and terminology/);
    // ...as read-only reference that must not be duplicated.
    expect(guidance).toMatch(/read-only reference/);
    expect(guidance).toMatch(/do not copy, quote, or restate sub-wiki content/);

    // The consult guidance reaches both planner and page prompts.
    const planner = createRepositoryPlannerPrompt(
      planningView(),
      undefined,
      "root",
    );
    expect(planner).toMatch(/CONSULT each subproject's sub-wiki/);

    const page = createRepositoryPagePrompt(pageJob(), [pageJob()], "en", "root");
    expect(page).toMatch(/CONSULT each subproject's sub-wiki/);

    // The subproject role must NOT gain the root's consult-the-quickstarts
    // directive: sub-wikis stay a root-only read-only reference.
    expect(recursionRoleGuidance("subproject")).not.toMatch(
      /CONSULT each subproject's sub-wiki/,
    );
  });

  test("absent role adds no recursion section (backward compatible)", () => {
    expect(recursionRoleGuidance(undefined)).toBe("");

    const planner = createRepositoryPlannerPrompt(planningView(), undefined);
    expect(planner).not.toContain("Monorepo subproject scope");
    expect(planner).not.toContain("Monorepo root scope");

    const page = createRepositoryPagePrompt(pageJob(), [pageJob()], "en");
    expect(page).not.toContain("Monorepo subproject scope");
    expect(page).not.toContain("Monorepo root scope");
  });
});
