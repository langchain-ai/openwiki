import { describe, expect, test } from "vitest";
import {
  BeginInput,
  NextPageInput,
  PlanPageInput,
  ProposedPageClaimInput,
  RunInput,
  SubmitPageInput,
  SubmitPlanInput,
  isValidHostId,
} from "../../src/integrations/core/protocol.ts";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const JOB_ID = "123e4567-e89b-42d3-a456-426614174001";

describe("OpenWiki host protocol", () => {
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

  test("requires a non-empty complete Claim set for page submission", () => {
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
    expect(() =>
      SubmitPageInput.parse({ runId: RUN_ID, jobId: JOB_ID, claims: [] }),
    ).toThrow();
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
});
