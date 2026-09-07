import { ClaimsError } from "../../claims/core/errors.js";
import {
  combineMemory,
  orientReflections,
  outlineReflections,
  readReflections,
} from "../../memory/reflection-retrieval.js";
import {
  orientChanges,
  outlineChanges,
  readChanges,
} from "../../memory/changes.js";
import {
  orientWiki,
  outlineWiki,
  readWiki,
  WikiRetrievalError,
} from "../../memory/retrieval.js";
import { HostIntegrationError } from "./errors.js";
import {
  OrientInput,
  OutlineInput,
  ReadInput,
  type ProtocolTool,
} from "./protocol.js";
import { resolveRepositoryRoot } from "./repository-root.js";

/**
 * Builds read-only memory tools without an active generation session.
 *
 * @returns The fixed orient, outline, and read MCP definitions.
 */
export function createRetrievalTools(): ProtocolTool[] {
  return [
    {
      name: "openwiki_orient",
      description:
        "Get the fixed repository overview and wiki page directory in longTerm, main changes and pending reflections in shortTerm, and branch/local context in working. Changes and findings link to pages; findings without known links are included. inCheckout identifies incorporated main history. No generation run is required.",
      schema: OrientInput,
      handle: async (input) =>
        retrieve(OrientInput.parse(input).root, async (root) => {
          const longTerm = await orientWiki(root);
          const pages = longTerm.pages.map(({ page }) => page);
          return {
            longTerm,
            ...(await combineMemory(
              orientChanges(root, pages),
              orientReflections(root, pages),
            )),
          };
        }),
    },
    {
      name: "openwiki_outline",
      description:
        "Get a wiki page's scope and section hierarchy in longTerm. shortTerm and working connect main and branch/local changes and pending reflections to section IDs. An unavailable field explains a source comparison gap; reflections remain independently available. No prior tool call or generation run is required.",
      schema: OutlineInput,
      handle: async (input) => {
        const request = OutlineInput.parse(input);
        return retrieve(request.root, async (root) => {
          const longTerm = await outlineWiki(root, request.page);
          return {
            longTerm,
            ...(await combineMemory(
              outlineChanges(root, longTerm.page),
              outlineReflections(root, longTerm.page),
            )),
          };
        });
      },
    },
    {
      name: "openwiki_read",
      description:
        "Read wiki sections, prose bindings, claims, and evidence in longTerm, with changed source resources linked to affected claims and provisional reflections in shortTerm and working. Inspect relevant source or Git history to verify affected evidence. Findings include evidence resources and related claim IDs. Omit sections for the whole page; parents include descendants once. inCheckout describes incorporated main history. No generation run is required.",
      schema: ReadInput,
      handle: async (input) => {
        const request = ReadInput.parse(input);
        return retrieve(request.root, async (root) => {
          const longTerm = await readWiki(root, request.page, request.sections);
          const sectionIds = longTerm.sections.map(({ id }) => id);
          return {
            longTerm,
            ...(await combineMemory(
              readChanges(root, longTerm.page, sectionIds),
              readReflections(root, longTerm.page, sectionIds),
            )),
          };
        });
      },
    },
  ];
}

/**
 * Resolves a repository and projects safe retrieval feedback through the host API.
 *
 * @param candidate - Host-supplied absolute repository path.
 * @param operation - Deterministic read using the canonical repository root.
 * @returns Consolidated knowledge and independently evaluated source changes and reflections.
 */
async function retrieve<T>(
  candidate: string,
  operation: (root: string) => Promise<T>,
): Promise<T> {
  const root = await resolveRepositoryRoot(candidate);
  try {
    return await operation(root);
  } catch (error) {
    if (error instanceof WikiRetrievalError) {
      throw new HostIntegrationError("invalid_input", error.message);
    }
    if (error instanceof ClaimsError) {
      throw new HostIntegrationError(
        "invalid_state",
        "Unable to read valid, contained OpenWiki page metadata. Check the wiki files and include the affected page in an OpenWiki update before retrying.",
      );
    }
    throw error;
  }
}
