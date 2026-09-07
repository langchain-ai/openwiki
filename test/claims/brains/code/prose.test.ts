import { describe, expect, test } from "vitest";
import { ClaimSession } from "../../../../src/claims/brains/code/session.ts";
import {
  assertPageProse,
  reconcilePageProse,
} from "../../../../src/claims/brains/code/prose.ts";
import { parseMarkdownSections } from "../../../../src/claims/brains/code/sections.ts";
import type { Claim } from "../../../../src/claims/core/types.ts";

/**
 * Shared factual claim used to exercise prose reconciliation independently of Git.
 */
const claim: Claim = {
  id: "claim_retry",
  statement: "Three attempts are allowed.",
  evidence: [{ resource: "repo://retry.ts", version: "v1" }],
};

/**
 * Representative page with direct parent prose and nested retry behavior.
 */
const markdown =
  "---\ntitle: Transactions\n---\n# Transactions\n\nOverview.\n\n## Failure handling\n\nThree attempts are allowed.\n";

/**
 * Establishes linked metadata through the same sparse API used by page authors.
 *
 * @returns Valid sections and bindings with generated stable IDs.
 */
function initialProse() {
  return reconcilePageProse(
    "/openwiki/transactions.md",
    markdown,
    undefined,
    [claim],
    {
      sections: [
        {
          location: "transactions.md#Transactions",
          description: "Transaction overview.",
        },
        {
          location: "transactions.md#Transactions#Failurehandling",
          description: "Retry limits.",
        },
      ],
      bindings: [
        {
          section: "transactions.md#Transactions#Failurehandling",
          text: "Three attempts are allowed.",
          claims: [claim.statement],
        },
      ],
    },
  );
}

describe("Markdown section locations", () => {
  test("extracts ancestry, unheaded text, setext headings, and escaped delimiters", () => {
    const sections = parseMarkdownSections(
      "/openwiki/page.md",
      "Intro.\r\n\r\nRoot\r\n====\r\n\r\n## C# 100%\r\n\r\nBody.\r\n\r\n### Nested\r\n\r\nChild.\r\n\r\n## Sibling\r\nEnd.\r\n",
    );
    expect(sections.map(({ location }) => location)).toEqual([
      "page.md",
      "page.md#Root",
      "page.md#Root#C%23100%25",
      "page.md#Root#C%23100%25#Nested",
      "page.md#Root#Sibling",
    ]);
    expect(sections[2].body).toContain("Body.");
    expect(sections[2].body).not.toContain("Child.");
  });

  test("ignores headings inside frontmatter, code, quotes, lists, and HTML", () => {
    const source =
      "---\ntitle: Hidden\n---\n# Real\n\n```md\n## Code\n```\n\n    # Indented\n\n> ## Quote\n\n- Item\n  ### List\n\n<div>\n## HTML\n</div>\n";
    expect(
      parseMarkdownSections("/openwiki/page.md", source).map(
        ({ location }) => location,
      ),
    ).toEqual(["page.md#Real"]);
  });
});

describe("page prose reconciliation", () => {
  test("allocates stable IDs and resolves new section locations and claim statements", () => {
    const prose = initialProse();
    expect(prose.sections[0].id).toMatch(/^section_/u);
    expect(prose.bindings[0]).toMatchObject({
      sectionId: prose.sections[1].id,
      claimIds: [claim.id],
    });
    expect(prose.bindings[0].id).toMatch(/^binding_/u);
    expect(
      reconcilePageProse(
        "/openwiki/transactions.md",
        markdown,
        prose,
        [claim],
        {},
      ),
    ).toEqual(prose);
  });

  test("retains bindings across section renames and changes one passage incrementally", () => {
    const previous = initialProse();
    const revisedMarkdown = markdown
      .replace("Failure handling", "Retries")
      .replace("Three attempts", "Five attempts");
    const revisedClaim = { ...claim, statement: "Five attempts are allowed." };
    const result = reconcilePageProse(
      "/openwiki/transactions.md",
      revisedMarkdown,
      previous,
      [revisedClaim],
      {
        sections: [
          {
            ...previous.sections[1],
            location: "transactions.md#Transactions#Retries",
          },
        ],
        bindings: [
          {
            id: previous.bindings[0].id,
            section: previous.sections[1].id,
            text: "Five attempts are allowed.",
            claims: [claim.id],
          },
        ],
      },
    );
    expect(result.sections[0]).toEqual(previous.sections[0]);
    expect(result.sections[1].id).toBe(previous.sections[1].id);
    expect(result.bindings[0].id).toBe(previous.bindings[0].id);
    expect(previous.bindings[0].text).toBe("Three attempts are allowed.");
  });

  test("rejects omitted bindings broken by a rewrite and allows corrected retry", () => {
    const prose = initialProse();
    const rewritten = markdown.replace(
      "Three attempts are allowed.",
      "At most three attempts.",
    );
    expect(() =>
      reconcilePageProse(
        "/openwiki/transactions.md",
        rewritten,
        prose,
        [claim],
        {},
      ),
    ).toThrow(/passage is missing/u);
    const corrected = reconcilePageProse(
      "/openwiki/transactions.md",
      rewritten,
      prose,
      [claim],
      {
        bindings: [
          {
            id: prose.bindings[0].id,
            section: prose.sections[1].id,
            text: "At most three attempts.",
            claims: [claim.id],
          },
        ],
      },
    );
    expect(corrected.bindings[0].id).toBe(prose.bindings[0].id);
  });

  test("rejects ambiguous headings, repeated passages, and passages belonging to descendants", () => {
    const prose = initialProse();
    expect(() =>
      assertPageProse(
        "/openwiki/transactions.md",
        `${markdown}\nThree attempts are allowed.`,
        prose,
        [claim],
      ),
    ).toThrow(/ambiguous/u);
    expect(() =>
      assertPageProse(
        "/openwiki/transactions.md",
        `${markdown}\n## Failure handling\nOther.`,
        prose,
        [claim],
      ),
    ).toThrow(/section location .* ambiguous/u);
    expect(() =>
      assertPageProse(
        "/openwiki/transactions.md",
        markdown,
        {
          ...prose,
          bindings: [{ ...prose.bindings[0], sectionId: prose.sections[0].id }],
        },
        [claim],
      ),
    ).toThrow(/passage is missing/u);
  });

  test("requires section descriptions and bindings for retained claims", () => {
    const prose = initialProse();
    expect(() =>
      assertPageProse(
        "/openwiki/transactions.md",
        markdown,
        { sections: [], bindings: [] },
        [claim],
      ),
    ).toThrow(/missing section description/u);
    expect(() =>
      reconcilePageProse(
        "/openwiki/transactions.md",
        markdown,
        prose,
        [claim],
        { removedBindingIds: [prose.bindings[0].id] },
      ),
    ).toThrow(/no prose binding/u);
    expect(() =>
      reconcilePageProse("/openwiki/transactions.md", markdown, prose, [], {}),
    ).toThrow(/unknown or retracted claim/u);
    expect(() =>
      reconcilePageProse(
        "/openwiki/transactions.md",
        markdown,
        prose,
        [claim],
        { removedSectionIds: [prose.sections[1].id] },
      ),
    ).toThrow(/unknown section/u);
  });

  test("accepts repeated additions after persistence and idempotent removals", () => {
    const prose = initialProse();
    const repeated = reconcilePageProse(
      "/openwiki/transactions.md",
      markdown,
      prose,
      [claim],
      {
        sections: [
          {
            location: prose.sections[1].location,
            description: prose.sections[1].description,
          },
        ],
        bindings: [
          {
            section: prose.sections[1].location,
            text: prose.bindings[0].text,
            claims: [claim.statement],
          },
        ],
        removedBindingIds: ["binding_already_removed"],
      },
    );
    expect(repeated).toEqual(prose);
  });

  test("rejects unknown revisions and conflicting decisions without changing inputs", () => {
    const prose = initialProse();
    expect(() =>
      reconcilePageProse(
        "/openwiki/transactions.md",
        markdown,
        prose,
        [claim],
        {
          sections: [{ ...prose.sections[0], id: "section_unknown" }],
        },
      ),
    ).toThrow(/unknown/u);
    expect(() =>
      reconcilePageProse(
        "/openwiki/transactions.md",
        markdown,
        prose,
        [claim],
        {
          sections: [prose.sections[0]],
          removedSectionIds: [prose.sections[0].id],
        },
      ),
    ).toThrow(/multiple decisions/u);
    expect(prose.sections).toHaveLength(2);
  });

  test("does not install claim revisions or clear stale issues when bindings fail", async () => {
    const prose = initialProse();
    const session = new ClaimSession({
      persisted: new Map([
        [
          "/openwiki/transactions.md",
          {
            schemaVersion: 1,
            pageVersion: `sha256:${"a".repeat(64)}`,
            claims: [claim],
            ...prose,
          },
        ],
      ]),
      resolver: {
        resolve: (resource) =>
          Promise.resolve({
            content: "five",
            evidence: { resource, version: "v2" },
          }),
      },
      issues: [
        {
          page: "/openwiki/transactions.md",
          claimId: claim.id,
          kind: "stale",
          resources: [claim.evidence[0].resource],
        },
      ],
      orphanPages: [],
    });
    const rewritten = markdown.replace("Three attempts", "Five attempts");
    const operations = [
      {
        op: "update" as const,
        id: claim.id,
        statement: "Five attempts are allowed.",
      },
    ];
    await expect(
      session.resolveClaims({
        page: "/openwiki/transactions.md",
        operations,
        prose: { markdown: rewritten, decisions: {} },
      }),
    ).rejects.toThrow(/passage is missing/u);
    expect(session.inspectClaims("/openwiki/transactions.md")[0]).toMatchObject(
      { statement: claim.statement, issue: { kind: "stale" } },
    );
    expect(session.inspectProse("/openwiki/transactions.md")).toEqual(prose);
    await session.resolveClaims({
      page: "/openwiki/transactions.md",
      operations,
      prose: {
        markdown: rewritten,
        decisions: {
          bindings: [
            {
              id: prose.bindings[0].id,
              section: prose.sections[1].id,
              text: "Five attempts are allowed.",
              claims: [claim.id],
            },
          ],
        },
      },
    });
    expect(
      session.inspectClaims("/openwiki/transactions.md")[0].issue,
    ).toBeUndefined();
    expect(
      session.inspectProse("/openwiki/transactions.md")?.bindings[0].text,
    ).toBe("Five attempts are allowed.");
  });
});
