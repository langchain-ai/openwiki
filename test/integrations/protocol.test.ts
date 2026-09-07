import { describe, expect, test } from "vitest";
import { RepositoryPlanInput } from "../../src/generation/plan-input.ts";
import { PageReconciliationInput } from "../../src/generation/page-input.ts";
import {
  BeginInput,
  NextPageInput,
  OrientInput,
  OutlineInput,
  PlanPageInput,
  ProposedPageClaimInput,
  RunInput,
  ReadInput,
  ReflectInput,
  SubmitPageInput,
  SubmitPlanInput,
  isValidHostId,
} from "../../src/integrations/core/protocol.ts";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const JOB_ID = "123e4567-e89b-42d3-a456-426614174001";

describe("OpenWiki host protocol", () => {
  test("shares strict reflection planning and page-result contracts with native workers", () => {
    const reflectionId = `reflection-${RUN_ID}`;
    const plan = {
      pages: [
        {
          path: "quickstart.md",
          title: "Quickstart",
          purpose: "Orient readers.",
          reflectionIds: [reflectionId],
        },
      ],
      discardedReflectionIds: [],
    };
    expect(SubmitPlanInput.parse({ ...plan, runId: RUN_ID })).toEqual({
      ...RepositoryPlanInput.parse(plan),
      runId: RUN_ID,
    });
    const submission = {
      reflectionResults: [
        { id: reflectionId, claims: ["An exact new statement."] },
      ],
    };
    expect(
      SubmitPageInput.parse({ ...submission, runId: RUN_ID, jobId: JOB_ID }),
    ).toEqual({
      ...PageReconciliationInput.parse(submission),
      runId: RUN_ID,
      jobId: JOB_ID,
    });
    expect(
      RepositoryPlanInput.safeParse({
        pages: [],
        discardedReflectionIds: ["../outside"],
      }).success,
    ).toBe(false);
    for (const result of [
      { id: reflectionId, claims: [" "] },
      { id: reflectionId, claims: [], status: "discarded" },
      { id: reflectionId },
    ]) {
      expect(
        PageReconciliationInput.safeParse({ reflectionResults: [result] })
          .success,
      ).toBe(false);
    }
    expect(
      PageReconciliationInput.parse({
        reflectionResults: [{ id: reflectionId, claims: [] }],
      }),
    ).toEqual({ reflectionResults: [{ id: reflectionId, claims: [] }] });
  });

  test("accepts only the finding and unversioned evidence for reflection creation", () => {
    const proposal = {
      root: "/tmp/repository",
      finding: "The initial attempt counts toward the retry limit.",
      evidence: [{ resource: "repo://src/retry.ts#L12-L20" }],
    };
    expect(
      ReflectInput.parse({ ...proposal, finding: ` ${proposal.finding} ` }),
    ).toEqual(proposal);
    for (const extra of [
      { id: RUN_ID },
      { runId: RUN_ID },
      { status: "pending" },
      { author: "agent" },
    ]) {
      expect(ReflectInput.safeParse({ ...proposal, ...extra }).success).toBe(
        false,
      );
    }
    for (const evidence of [
      [],
      [{ resource: " " }],
      [{ resource: "repo://src/retry.ts", version: "supplied" }],
    ]) {
      expect(ReflectInput.safeParse({ ...proposal, evidence }).success).toBe(
        false,
      );
    }
    expect(ReflectInput.safeParse({ ...proposal, finding: " " }).success).toBe(
      false,
    );
  });

  test("keeps retrieval inputs fixed and independent of generation runs", () => {
    expect(OrientInput.parse({ root: " /tmp/repository " })).toEqual({
      root: "/tmp/repository",
    });
    expect(
      OutlineInput.parse({
        root: "/tmp/repository",
        page: " concepts/jobs.md ",
      }),
    ).toEqual({ root: "/tmp/repository", page: "concepts/jobs.md" });
    expect(
      ReadInput.parse({ root: "/tmp/repository", page: "concepts/jobs.md" }),
    ).toEqual({ root: "/tmp/repository", page: "concepts/jobs.md" });
    expect(
      ReadInput.parse({
        root: "/tmp/repository",
        page: "concepts/jobs.md",
        sections: [" section_retry "],
      }).sections,
    ).toEqual(["section_retry"]);
    for (const extra of [
      { query: "retries" },
      { runId: RUN_ID },
      { page: "jobs.md" },
    ]) {
      expect(() =>
        OrientInput.parse({ root: "/tmp/repository", ...extra }),
      ).toThrow();
    }
    for (const sections of [[], [""], ["   "], "section_retry"]) {
      expect(() =>
        ReadInput.parse({ root: "/tmp/repository", page: "jobs.md", sections }),
      ).toThrow();
    }
    expect(() =>
      OutlineInput.parse({ root: "/tmp/repository", page: "" }),
    ).toThrow();
    expect(() =>
      ReadInput.parse({
        root: "/tmp/repository",
        page: "jobs.md",
        query: "retries",
      }),
    ).toThrow();
  });

  test("validates strict begin and run inputs", () => {
    expect(
      BeginInput.parse({
        root: " /tmp/repository ",
        mode: "update",
        language: " fr ",
        force: true,
      }),
    ).toEqual({
      root: "/tmp/repository",
      mode: "update",
      language: "fr",
      force: true,
    });
    expect(() => BeginInput.parse({ root: "/tmp", mode: "chat" })).toThrow();
    expect(() =>
      BeginInput.parse({ root: "/tmp", mode: "init", extra: true }),
    ).toThrow();
    expect(RunInput).toBe(NextPageInput);
    expect(() => RunInput.parse({ runId: "not-a-uuid" })).toThrow();
    expect(() => RunInput.parse({ runId: RUN_ID, extra: true })).toThrow();
  });

  test("validates complete strict plan payloads", () => {
    expect(
      PlanPageInput.parse({
        path: " /openwiki/runtime.md ",
        title: " Runtime ",
        purpose: " Explain execution. ",
        seedPaths: [" src/runtime.ts "],
        relatedPages: [" /openwiki/quickstart.md "],
        instructions: [" Preserve terminology. "],
      }),
    ).toEqual({
      path: "/openwiki/runtime.md",
      title: "Runtime",
      purpose: "Explain execution.",
      seedPaths: ["src/runtime.ts"],
      relatedPages: ["/openwiki/quickstart.md"],
      instructions: ["Preserve terminology."],
    });
    expect(SubmitPlanInput.parse({ runId: RUN_ID, pages: [] })).toEqual({
      runId: RUN_ID,
      pages: [],
    });
    expect(() =>
      SubmitPlanInput.parse({
        runId: RUN_ID,
        pages: [{ path: "page.md", title: "Page", purpose: "Purpose" }],
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      PlanPageInput.parse({
        path: "page.md",
        title: "Page",
        purpose: "Purpose",
        extra: true,
      }),
    ).toThrow();
  });

  test("validates sparse Claim reconciliation fields", () => {
    expect(
      ProposedPageClaimInput.parse({
        id: " claim_existing ",
        statement: " The runtime starts from the CLI. ",
        evidence: [{ resource: " repo://src/cli.ts#L1-L20 " }],
      }),
    ).toEqual({
      id: "claim_existing",
      statement: "The runtime starts from the CLI.",
      evidence: [{ resource: "repo://src/cli.ts#L1-L20" }],
    });
    expect(
      SubmitPageInput.parse({
        runId: RUN_ID,
        jobId: JOB_ID,
        confirmedClaimIds: [" claim_existing "],
        retractedClaimIds: [" claim_removed "],
      }),
    ).toEqual({
      runId: RUN_ID,
      jobId: JOB_ID,
      confirmedClaimIds: ["claim_existing"],
      retractedClaimIds: ["claim_removed"],
    });
    expect(() =>
      SubmitPageInput.parse({
        runId: RUN_ID,
        jobId: JOB_ID,
        claims: [{ statement: "Claim", evidence: [] }],
      }),
    ).toThrow();
    expect(() =>
      SubmitPageInput.parse({
        runId: RUN_ID,
        jobId: JOB_ID,
        claims: [
          {
            statement: "Claim",
            evidence: [{ resource: "repo://README.md", version: "owned" }],
          },
        ],
      }),
    ).toThrow();
  });

  test("accepts only bounded canonical host identities", () => {
    expect(isValidHostId("codex")).toBe(true);
    expect(isValidHostId("claude-code")).toBe(true);
    expect(isValidHostId("a".repeat(64))).toBe(true);
    expect(isValidHostId("Codex")).toBe(false);
    expect(isValidHostId("codex_agent")).toBe(false);
    expect(isValidHostId("a".repeat(65))).toBe(false);
  });

  test("accepts sparse prose decisions without trimming exact passage whitespace", () => {
    const input = {
      runId: RUN_ID,
      jobId: JOB_ID,
      sections: [
        {
          location: " runtime.md#Runtime ",
          description: " Runtime behavior. ",
        },
      ],
      bindings: [
        {
          section: " runtime.md#Runtime ",
          text: "  Exact passage.\n",
          claims: [" claim_runtime "],
        },
      ],
      removedBindingIds: [" binding_removed "],
    };
    const parsed = SubmitPageInput.parse(input);
    expect(parsed.sections?.[0]).toEqual({
      location: "runtime.md#Runtime",
      description: "Runtime behavior.",
    });
    expect(parsed.bindings?.[0]).toEqual({
      section: "runtime.md#Runtime",
      text: "  Exact passage.\n",
      claims: ["claim_runtime"],
    });
    expect(parsed.removedBindingIds).toEqual(["binding_removed"]);
    expect(() =>
      SubmitPageInput.parse({
        ...input,
        bindings: [{ ...input.bindings[0], claims: [] }],
      }),
    ).toThrow();
    expect(() =>
      SubmitPageInput.parse({
        ...input,
        bindings: [{ ...input.bindings[0], text: " \n" }],
      }),
    ).toThrow();
    expect(() =>
      SubmitPageInput.parse({
        ...input,
        sections: [{ ...input.sections[0], description: " " }],
      }),
    ).toThrow();
  });
});
