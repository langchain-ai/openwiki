import { z } from "zod";
import {
  ClaimsError,
  ClaimsPageMissingError,
} from "../../claims/core/errors.js";
import {
  readWikiSections,
  searchWiki,
  WIKI_RETRIEVAL_LIMITS,
  WikiRetrievalError,
} from "../../retrieval/wiki.js";
import {
  listWikiWorkspaces,
  listWorkspaceWikis,
  WikiWorkspaceError,
} from "../../linking/wiki-workspaces.js";
import { HostIntegrationError } from "./errors.js";
import type { ProtocolTool } from "./protocol.js";
import { resolveRepositoryRoot } from "./repository-root.js";

/**
 * Shared non-empty string boundary for retrieval tool inputs.
 */
const CanonicalString = z.string().trim().min(1);

/**
 * Strict schema for compact repository wiki search.
 */
export const SearchInput = z
  .object({
    root: CanonicalString.describe(
      "Absolute Git repository root containing openwiki/.",
    ),
    query: CanonicalString.max(WIKI_RETRIEVAL_LIMITS.queryCharacters).describe(
      "Repository question, behavior, or concept to find in the wiki.",
    ),
    paths: z
      .array(CanonicalString.max(WIKI_RETRIEVAL_LIMITS.sourcePathCharacters))
      .max(WIKI_RETRIEVAL_LIMITS.sourcePathHints)
      .optional()
      .describe(
        "Optional repository-relative source paths that boost related wiki sections.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(WIKI_RETRIEVAL_LIMITS.searchResults)
      .optional()
      .describe("Optional number of ranked results to return."),
    workspace: CanonicalString.max(
      WIKI_RETRIEVAL_LIMITS.workspaceReferenceCharacters,
    )
      .optional()
      .describe(
        "Optional workspace ID or unique name overriding automatic workspace selection.",
      ),
  })
  .strict();

/**
 * Strict schema for listing workspaces containing one wiki.
 */
export const ListWorkspacesInput = z
  .object({
    root: CanonicalString.describe(
      "Absolute Git repository root containing openwiki/.",
    ),
    wiki: CanonicalString.max(WIKI_RETRIEVAL_LIMITS.wikiIdCharacters)
      .optional()
      .describe(
        "Optional known wiki ID; omit to inspect the current repository.",
      ),
  })
  .strict();

/**
 * Strict schema for listing member wikis in one workspace.
 */
export const ListWikisInput = z
  .object({
    root: CanonicalString.describe(
      "Absolute Git repository root containing openwiki/.",
    ),
    workspace: CanonicalString.max(
      WIKI_RETRIEVAL_LIMITS.workspaceReferenceCharacters,
    ).describe(
      "Workspace ID or unique name returned by openwiki_list_workspaces.",
    ),
  })
  .strict();

/**
 * Strict schema for exact section reads from search references.
 */
export const ReadInput = z
  .object({
    root: CanonicalString.describe(
      "Absolute Git repository root containing openwiki/.",
    ),
    page: CanonicalString.max(WIKI_RETRIEVAL_LIMITS.pageCharacters).describe(
      'Wiki page from a search ref, e.g. "openwiki/architecture/jobs.md".',
    ),
    sections: z
      .array(CanonicalString.max(WIKI_RETRIEVAL_LIMITS.sectionAnchorCharacters))
      .min(1)
      .max(WIKI_RETRIEVAL_LIMITS.sectionAnchors)
      .describe('Heading anchors from search refs, e.g. ["retry-control"].'),
    wiki: CanonicalString.max(WIKI_RETRIEVAL_LIMITS.wikiIdCharacters)
      .optional()
      .describe(
        "Linked wiki ID from the selected search result; omit for the current repository.",
      ),
  })
  .strict();

/**
 * Creates read-only repository memory tools independent of generation sessions.
 *
 * @returns Ordered search and exact-section read tool definitions.
 */
export function createRetrievalTools(): ProtocolTool[] {
  return [
    {
      name: "openwiki_list_workspaces",
      description: [
        "List named wiki workspaces containing one repository wiki.",
        "Omit wiki to inspect the current repository; pass a known wiki ID to inspect another reachable wiki.",
        "Returns the persistent active workspace when configured.",
      ].join(" "),
      schema: ListWorkspacesInput,
      handle: async (input) => {
        const request = ListWorkspacesInput.parse(input);
        return runRetrieval("list", async () => {
          const root = await resolveRepositoryRoot(request.root);
          return listWikiWorkspaces(root, request.wiki);
        });
      },
    },
    {
      name: "openwiki_list_wikis",
      description: [
        "List every repository wiki in one named workspace containing the current repository.",
        "Pass a workspace ID or unique name returned by openwiki_list_workspaces.",
      ].join(" "),
      schema: ListWikisInput,
      handle: async (input) => {
        const request = ListWikisInput.parse(input);
        return runRetrieval("list", async () => {
          const root = await resolveRepositoryRoot(request.root);
          return listWorkspaceWikis(root, request.workspace);
        });
      },
    },
    {
      name: "openwiki_search",
      description: [
        "Search an existing repository OpenWiki without a model call or generation run.",
        "Do not call at task start or preload linked wikis; use retrieval when requested or when unfamiliar architecture, dependency behavior, or unresolved source uncertainty materially affects the task, then stop once grounded.",
        "A standalone wiki searches locally; one containing workspace is automatic; an active workspace resolves overlaps.",
        "When multiple workspaces remain ambiguous, returns status=workspace_required with choices so the agent can ask the user and retry with workspace.",
        "Returns compact ranked results; split each ref at # into the page and exact heading anchor for openwiki_read.",
        "Optional source paths boost related sections but do not filter other matches.",
        "Empty results are valid.",
      ].join(" "),
      schema: SearchInput,
      handle: async (input) => {
        const request = SearchInput.parse(input);
        return runRetrieval("search", async () => {
          const root = await resolveRepositoryRoot(request.root);
          return searchWiki(root, request);
        });
      },
    },
    {
      name: "openwiki_read",
      description: [
        "Read one or more complete Markdown sections selected from openwiki_search refs.",
        "Pass the result's wiki ID, page, and heading anchors exactly; omit wiki for an unlinked or current repository result.",
        "No model call or generation run is required.",
      ].join(" "),
      schema: ReadInput,
      handle: async (input) => {
        const request = ReadInput.parse(input);
        return runRetrieval("read", async () => {
          const root = await resolveRepositoryRoot(request.root);
          return readWikiSections(root, request);
        });
      },
    },
  ];
}

/**
 * Executes retrieval and maps expected failures to bounded host errors.
 *
 * @param operation - Retrieval operation used for error classification.
 * @param task - Deferred repository retrieval operation.
 * @returns Successful retrieval result.
 * @throws {HostIntegrationError} For expected input or repository-state errors.
 */
async function runRetrieval<T>(
  operation: "list" | "read" | "search",
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof HostIntegrationError) throw error;
    if (error instanceof WikiRetrievalError) {
      throw new HostIntegrationError("invalid_input", error.message);
    }
    if (error instanceof WikiWorkspaceError) {
      throw new HostIntegrationError("invalid_state", error.message);
    }
    if (operation === "read" && error instanceof ClaimsPageMissingError) {
      throw new HostIntegrationError(
        "invalid_input",
        "The requested OpenWiki page does not exist.",
      );
    }
    if (error instanceof ClaimsError) {
      throw new HostIntegrationError(
        "invalid_state",
        `Unable to ${operation} the repository OpenWiki safely. Check the wiki and retry.`,
      );
    }
    throw error;
  }
}
