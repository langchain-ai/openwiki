/**
 * The author's page write: prose and Claims, or neither.
 *
 * Grounding is enforced by the tool surface rather than requested in a prompt.
 * The author has no call that writes prose on its own, so a page cannot exist
 * without claims behind it, and the coordinator never has to carry an author's
 * propositions through a tool result.
 *
 * Both failure directions are explicit. Evidence the resolver refuses comes back
 * naming the resource it refused, with nothing written, so the author - which
 * still holds the file - can fix that one anchor and call again. A page that was
 * never written has no prose at all, which the pool reads as an author that did
 * nothing rather than as a page needing repair.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { ClaimSession } from "../claims/brains/code/session.js";
import type { ClaimOperation } from "../claims/core/types.js";

/** Backend capability this needs: one page write. */
interface PageWriteBackend {
  write(
    filePath: string,
    content: string,
  ): { error?: string } | Promise<{ error?: string }>;
}

const EvidenceSchema = z
  .string()
  .min(1)
  .describe("repo://path#L10-L24, or repo://path for whole-file evidence");

const EstablishClaimsSchema = z.object({
  page: z.string().min(1).describe("The page path you were assigned."),
  claims: z
    .array(
      z.object({
        statement: z.string().min(1),
        evidence: z.array(EvidenceSchema).min(1),
      }),
    )
    .min(1),
});

const WritePageSchema = z.object({
  page: z.string().min(1).describe("The page path you were assigned."),
  markdown: z
    .string()
    .min(1)
    .describe("The complete page, including its front matter."),
});

/**
 * Resolves an author-supplied page path to the one form the claim store takes.
 *
 * @param page - Page path as the author wrote it.
 * @returns Absolute /openwiki path ending in .md.
 */
function canonicalPage(page: string): string {
  const bare = page
    .trim()
    .replace(/^\/+/u, "")
    .replace(/^openwiki\//u, "");
  const withExtension = /\.md$/iu.test(bare) ? bare : `${bare}.md`;
  return `/openwiki/${withExtension}`;
}

/**
 * Normalizes an author-supplied evidence resource.
 *
 * Line ranges, triple slashes, and trailing slashes are syntax the resolver
 * rejects and the author did not mean, so they are corrected rather than
 * bounced: 15 of 66 claim failures in one run were exactly these.
 *
 * @param resource - Resource as written.
 * @returns Normalized resource.
 */
export function normalizeEvidence(resource: string): string {
  return resource
    .trim()
    .replace(/^repo:\/{3,}/u, "repo://")
    .replace(/#L\d+(?:-L?\d+)?$/u, "")
    .replace(/\/+$/u, "");
}

/**
 * Creates the author's two-step write: claims, then prose.
 *
 * Two calls rather than one, because a single call asking for both a page and
 * its claims makes them compete for one completion and the prose is what gives
 * way. establish_claims takes the propositions; write_page refuses a page with
 * no claims. Prose therefore cannot exist ungrounded - there is no call that
 * writes it alone - and each output gets a completion to itself. The order is
 * claims first, so the page is written from propositions already derived.
 *
 * @param session - Run-scoped claim state.
 * @param backend - Wiki filesystem backend.
 * @returns The two tools an author writes through.
 */
export function createAuthorWriteTools(
  session: ClaimSession,
  backend: PageWriteBackend,
) {
  const establishClaims = tool(
    async (rawInput) => {
      const input = EstablishClaimsSchema.parse(rawInput);
      const page = canonicalPage(input.page);
      const operations: ClaimOperation[] = input.claims.map((claim) => ({
        op: "add",
        statement: claim.statement,
        evidence: claim.evidence.map((resource) => ({
          resource: normalizeEvidence(resource),
        })),
      }));
      try {
        await session.resolveClaims({ page, operations });
      } catch (error) {
        return JSON.stringify({
          established: 0,
          error: error instanceof Error ? error.message : String(error),
          hint: "Nothing was established. Fix the resource this names - cite the symbol the file declares, or the file itself - and call again.",
        });
      }
      return JSON.stringify({
        page,
        established: session.inspectClaims(page).length,
      });
    },
    {
      name: "establish_claims",
      description:
        "Establish your page's material propositions in one call, before writing it - two if the page is large, since every call replays everything you have read. Each is one concise atomic proposition with repo://path#L10-L24 evidence - no symbols, no directories, and the narrowest line range that carries the fact; cite the bare repo://path only when the whole file is the evidence. Call it in batches as you work rather than once at the end. write_page refuses a page with no claims, so this comes first.",
      schema: EstablishClaimsSchema,
    },
  );

  const writePage = tool(
    async (rawInput) => {
      const input = WritePageSchema.parse(rawInput);
      const page = canonicalPage(input.page);
      const established = session.inspectClaims(page).length;
      if (established === 0) {
        return JSON.stringify({
          written: false,
          error:
            "This page has no claims. Call establish_claims for it first: a page's prose has to be grounded in propositions, and nothing here writes ungrounded prose.",
        });
      }
      const result = await backend.write(page, input.markdown);
      return result.error
        ? JSON.stringify({ written: false, error: result.error })
        : JSON.stringify({ written: true, page, claims: established });
    },
    {
      name: "write_page",
      description:
        "Write your assigned page. It refuses a page with no established claims, so call establish_claims first and write the prose from those propositions. Pass the complete Markdown including its front matter.",
      schema: WritePageSchema,
    },
  );

  return [establishClaims, writePage];
}
