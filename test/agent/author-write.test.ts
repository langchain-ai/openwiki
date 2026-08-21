import type { StructuredToolInterface } from "@langchain/core/tools";
import { describe, expect, test } from "vitest";
import {
  createAuthorWriteTools,
  normalizeEvidence,
} from "../../src/agent/author-write.ts";
import { ClaimSession } from "../../src/claims/brains/code/session.ts";

function getTool(
  tools: StructuredToolInterface[],
  name: string,
): StructuredToolInterface {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function createSession(): ClaimSession {
  let nextId = 0;
  return new ClaimSession({
    resolver: {
      resolve: (resource) =>
        Promise.resolve({
          evidence: { resource, version: `revision:${resource}` },
          content: resource,
        }),
    },
    persisted: new Map(),
    issues: [],
    orphanPages: [],
    createClaimId: () => `claim_${++nextId}`,
  });
}

describe("author write tools", () => {
  test("preserves supported line ranges while normalizing the URI prefix", () => {
    expect(normalizeEvidence(" repo:///src/config.ts#L10-L24 ")).toBe(
      "repo://src/config.ts#L10-L24",
    );
  });

  test("establishes valid neighbors and reports only the rejected claim", async () => {
    const session = createSession();
    const establish = getTool(
      createAuthorWriteTools(session, { write: () => ({}) }),
      "establish_claims",
    );
    const output = JSON.parse(
      String(
        await establish.invoke({
          page: "services/example.md",
          claims: [
            {
              statement: "The first fact is valid.",
              evidence: ["repo://src/first.ts#L1-L2"],
            },
            {
              statement: "The duplicate evidence claim is rejected.",
              evidence: [
                "repo://src/repeated.ts#L3-L4",
                "repo://src/repeated.ts#L3-L4",
              ],
            },
            {
              statement: "The final fact is also valid.",
              evidence: ["repo://src/final.ts#L5-L6"],
            },
          ],
        }),
      ),
    ) as {
      accepted: number;
      established: number;
      rejected: Array<{ claim: number; statement: string; error: string }>;
      hint: string;
    };

    expect(output.accepted).toBe(2);
    expect(output.established).toBe(2);
    expect(output.rejected).toEqual([
      {
        claim: 2,
        statement: "The duplicate evidence claim is rejected.",
        error: "Claim evidence repeats repo://src/repeated.ts#L3-L4",
      },
    ]);
    expect(output.hint).toContain("Do not write rejected facts");
    expect(
      session
        .inspectClaims("/openwiki/services/example.md")
        .map((claim) => claim.statement),
    ).toEqual(["The first fact is valid.", "The final fact is also valid."]);
  });
});
