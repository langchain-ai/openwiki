/**
 * The init-only page authoring subagent.
 *
 * Authoring is the phase that dominates a documentation run: 111 write_file and
 * edit_file calls over 270 messages in the measured gated run, 26m21s of a
 * 60-minute budget, and every one of those a sequential model turn. Discovery
 * and review can be collapsed into the REPL, but a page's prose has to come out
 * of a model turn, so the only way it gets cheaper is more turns at once.
 *
 * Fanning these out from `eval` costs one orchestrator turn for N pages. What it
 * risks is the thing a wiki is for: an author that sees only its own page cannot
 * describe how its subject relates to anything else. So the split is graph
 * against node. The coordinator owns the inventory, the relationship map, the
 * page paths, quickstart, the link audit and the QA loop - everything that is
 * cross-page by nature and already produced before fan-out. An author owns one
 * page and is handed its edges, so it states its relationships without having
 * read its neighbours.
 *
 * Each author establishes its own propositions with repo:// evidence before it
 * writes, so evidence failures can be repaired while the source is still open.
 */

import type { SubAgent } from "deepagents";
import type { ClaimSession } from "../claims/brains/code/session.js";
import { createAuthorWriteTools } from "./author-write.js";
import {
  createFilesystemMiddleware,
  type AnyBackendProtocol,
  type FsToolName,
} from "deepagents";
import type { OpenWikiCommand, OpenWikiOutputMode } from "./types.js";

/**
 * The author's filesystem surface.
 *
 * `execute` is absent because path permissions cannot constrain a shell.
 * `write_file` is absent so new pages must go through `write_page`, after
 * `establish_claims`; `edit_file` remains for refining a grounded page. The
 * shared backend confines edits to OpenWiki and enforces `.openwikiignore`.
 */
export const AUTHOR_FILESYSTEM_TOOLS = [
  "read_file",
  "ls",
  "glob",
  "grep",
  "edit_file",
] as const satisfies readonly FsToolName[];

const PAGE_AUTHOR_DESCRIPTION = [
  "Writes one assigned wiki page from a supplied evidence brief and relationship edges, and establishes that page's Claims itself with repo:// evidence.",
  "Dispatch concurrently through author_pages, one page per task. It establishes its claims and then writes its page, and returns a short plain-text note rather than JSON: how many claims a page established comes from the claim store.",
].join(" ");

const PAGE_AUTHOR_SYSTEM_PROMPT = `You author exactly one wiki page and report what you established.

Your assignment names one canonical page path, its inventory unit, the evidence paths and symbols to inspect, its focused tests, and its relationship edges. Write that page and nothing else.

Hard constraints:
- Write only the single page path you were assigned. Never create, edit, or delete another page, an index, quickstart, or the plan file. Another author owns each of those concurrently.
- Do not read /openwiki/_plan.md or any other wiki page. Your assignment is complete by construction: if something you need is missing from it, say so in your report rather than going to look for it. Your neighbours' pages are being written while you work, so what you would read is half-finished.
- Read repository source and tests as evidence, starting from the paths and symbols your assignment names. Never document a secret, credential, token, or .env value.
- Prefer grep and targeted reads over reading a large file whole.
- Do not invent files, modules, APIs, or behavior. Every material proposition must be supported by source or tests you inspected.

Establish the claims first, then write the page from them:
- Derive the material factual propositions from what you inspected, before drafting prose. Each is one concise atomic proposition with the repo://path#L10-L24 evidence that establishes it, using repo://path only when the whole file is the evidence. Split compound facts rather than collapsing a component into one summary proposition.
- Cover the categories your assignment and the page's subject require: responsibilities, why it exists, ownership and entrypoints, important symbols, dependencies and data flow, invariants and lifecycle ordering, extension points, focused tests and what they prove, validation, schemas, and scope boundaries the evidence supports.
- Four of those a reader cannot do without, because they are what someone about to change this component opens the page for, so make sure your set answers all four and does not merely touch them: what it is responsible for and deliberately is not; where it lives, down to packages, files, and named entrypoints; what crosses its boundary in each direction, including the data or contract that passes; and how someone would check they had not broken it. These are a floor beneath the categories above, not a replacement for them.
- Name the thing rather than the category. "Covered by unit tests" establishes nothing; "TestQueueRunPayload proves an empty hash_key is rejected before any Redis write" establishes something a reader can act on. The same goes for "depends on the database" against the named client and the table it writes.
- A reader asking how to check a change needs to be able to run it, so say what running it takes: the test and the behaviour it proves, the command or target that runs it, and what it needs in place first - a live database or queue, a setup script, a separate suite that the ordinary one will not catch. Your assignment names the command; follow it into the Makefile or workflow that defines it and report what it actually does.
- A substantial component's page establishes several dozen propositions, because that is how many separable facts its evidence contains. Under ten means the evidence was not read rather than that the subject was small - and a page whose subject really is small says so, in a proposition, rather than being quietly thin.
- Write the page from that proposition set. Every proposition must appear as explained prose stating the mechanism and the specific names, values, ordering, and conditions a reader needs to act on it. Prose may exceed the claim set where it connects or contextualises, but nothing material should appear on the page without a proposition behind it.
- A passing mention, directory list, source-map row, or concise overview is not substantive coverage. A path or symbol points at evidence; it never substitutes for stating what that evidence says.
- An agent or human should be able to understand this component and its workflows from your page without reading a single line of code outside the wiki.
- State each supplied relationship in the prose that explains it, linking the target page by the path you were given. Do not invent link targets: another author may not have written that page yet, and a guessed path is a broken link.
- Begin the file with valid OKF v0.2 concept front matter. Include \`type\`; add \`title\` and \`description\` when useful for retrieval. Never write \`generated\` or the superseded \`timestamp\`: OpenWiki owns provenance.
- Claims are structured data passed to establish_claims, never text in the page. A line reading "Evidence: repo://..." in the Markdown is not a claim and grounds nothing.

Use \`establish_claims\` in batches as you read, then write the page:
- If a resource is refused, nothing was established. It names the resource: fix that one anchor - the line range the fact really occupies, or the file itself - and call again. Do not drop the claim and do not paste evidence into the prose instead.
- Then call \`write_page\` with the complete Markdown. It refuses a page with no claims, so the propositions come first and the prose is written from them.

Reporting:
- Finish with a short plain-text note: what you wrote, and any assigned area you could not document from evidence and why. It is read by a person, not parsed, so do not wrap it in JSON.
- Report an area you could not document rather than writing an unsupported page.`;

/**
 * The author establishes its own claims.
 *
 * It had returned them instead, for the coordinator to establish. That put a
 * page's forty-odd propositions through a JSON return contract, a parser, and a
 * pool, and every one of those seams broke at least once: a schema that never
 * bound, a payload too large for a tool result, a relative page path the claim
 * store refused, and one unresolvable symbol atomically discarding a whole
 * page's claims. In one graded run 65 of 90 pages established nothing.
 *
 * The author already had resolve_claims - subagents inherit the parent's tools -
 * and was being told not to use it. It is also the only participant that can
 * actually repair bad evidence, because it has the file open: a coordinator
 * downstream can only degrade a rejected line range to its file and hope.
 *
 * Counts come from the claim session afterwards rather than from the author's
 * report, so there is nothing to parse and nothing that can disagree with the
 * store.
 */
const PAGE_AUTHOR_SUBAGENT: SubAgent = {
  name: "page-author",
  description: PAGE_AUTHOR_DESCRIPTION,
  systemPrompt: PAGE_AUTHOR_SYSTEM_PROMPT,
};

/**
 * Returns the init-only page authoring subagent.
 *
 * @param command - Current OpenWiki command.
 * @param outputMode - Current output target.
 * @param backend - Shared wiki backend; its docsOnly and ignore rules are what
 *   confine an author to the wiki without a path permission.
 * @returns The author for repository init, otherwise no subagents.
 */
export function resolvePageAuthorSubagents(
  command: OpenWikiCommand,
  outputMode: OpenWikiOutputMode,
  backend: AnyBackendProtocol,
  session: ClaimSession,
): SubAgent[] {
  if (command !== "init" || outputMode !== "repository") {
    return [];
  }

  // Named explicitly rather than inherited. DeepAgents gives a subagent
  // `agentParams.tools ?? defaultTools`, so an author with no tools field
  // silently receives whatever the graph exposes - which made "does the author
  // have a claims tool" a question about two files in different packages,
  // answered wrongly in a comment.
  return [
    {
      ...PAGE_AUTHOR_SUBAGENT,
      // An author writes one page and grounds it. It has no use for
      // inspect_claims or delete_file, and the filesystem middleware below
      // supplies the rest of its surface.
      tools: createAuthorWriteTools(session, backend),
      middleware: [
        ...(PAGE_AUTHOR_SUBAGENT.middleware ?? []),
        createFilesystemMiddleware({
          backend,
          tools: [...AUTHOR_FILESYSTEM_TOOLS],
        }),
      ],
    },
  ];
}
