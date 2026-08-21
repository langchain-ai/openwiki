/**
 * Removes DeepAgents' auto-added `general-purpose` subagent from an init run.
 *
 * A repository init has a named subagent for every fan-out it wants: authors
 * write pages against a supplied brief and establish their own Claims,
 * reviewers read and never write, question-finders return a fixed text shape.
 * `general-purpose` is none of those. It inherits the main agent's whole tool
 * set - the connector tools, the Claims tools, and a filesystem middleware
 * carrying the agent's own write permissions - with a prompt that says only
 * "research complex questions". So it is the one dispatch target that can
 * author a page without a brief, without edges, and without the claim
 * discipline every other authoring path enforces, and the coordinator reaches
 * for it precisely when a task does not fit a named subagent.
 *
 * DeepAgents can drop it at construction, but only through a harness profile
 * (`generalPurposeSubagent: { enabled: false }`), and profiles resolve off a
 * model instance through `getModelProvider`, which recognizes ChatAnthropic,
 * ChatOpenAI and ChatGoogleGenerativeAI and nothing else. Measured against
 * deepagents 1.12.0, that leaves the subagent in place for `gemini`,
 * `openrouter` and `bedrock` while removing it for `anthropic` and the
 * ChatOpenAI-backed providers - a boundary that holds or not depending on which
 * `--provider` the run was started with. This closes it the same way for all of
 * them.
 *
 * The enforcement is on the `task` tool itself rather than on either caller,
 * because there are two callers and only one of them is interceptable. The REPL
 * reaches subagents through `@langchain/quickjs`'s `task()` global, which
 * resolves the tool out of `request.tools` in `wrapModelCall` and invokes it
 * directly; no `wrapToolCall` runs on that path, and LangChain rejects
 * substituting a wrapper into `request.tools` outright ("You have modified a
 * tool in `wrapModelCall`") to keep ToolNode's execution identity intact. The
 * one object both callers share is the registered tool, so the guard patches
 * that in place. Order in the middleware list is therefore irrelevant: whoever
 * holds a reference holds the guarded tool.
 */

import { ToolMessage } from "@langchain/core/messages";
import { GENERAL_PURPOSE_SUBAGENT } from "deepagents";
import { createMiddleware } from "langchain";

/** The subagent name to refuse, read from DeepAgents so a rename cannot silently disarm this. */
const GENERAL_PURPOSE = GENERAL_PURPOSE_SUBAGENT.name;

/**
 * What the coordinator gets back instead of a subagent.
 *
 * It names the constraint rather than the failure, because the model recovers
 * by picking a different `subagentType`, and the roster it should pick from is
 * already in the task tool's description.
 */
const REFUSAL = `The "${GENERAL_PURPOSE}" subagent is not available in this run. Dispatch one of the named subagents listed in the task tool description instead, or do the work yourself.`;

/** The registered `task` tool, narrowed to the two members the guard touches. */
export interface GuardableTaskTool {
  name: string;
  description: string;
  invoke: (input: unknown, config?: unknown) => Promise<unknown>;
}

/**
 * Drops every line of the task tool's description that names the subagent.
 *
 * DeepAgents renders one `- <name>: <description>` line per subagent and closes
 * with a usage note that reads "When only general-purpose is available, ...".
 * Both mention it and neither survives its removal, so the filter is by mention
 * rather than by position - the roster's exact layout is not ours to depend on.
 *
 * @param description - The task tool's rendered description.
 * @returns The description with every general-purpose line removed.
 */
export function stripGeneralPurpose(description: string): string {
  return description
    .split("\n")
    .filter((line) => !line.includes(GENERAL_PURPOSE))
    .join("\n");
}

/**
 * Reads the requested subagent name, and which caller asked for it.
 *
 * The two callers are distinguishable by shape and have to fail differently, so
 * the same read reports both. ToolNode invokes with the tool call itself
 * (`{ name, args, id, type: "tool_call" }`); the REPL bridge invokes with the
 * arguments directly, having stripped the tool call so the task tool returns
 * text rather than a Command. A shape neither recognizes yields no subagent
 * name and is passed through - the tool's own schema is what rejects malformed
 * input.
 *
 * @param input - Whatever the caller passed to `task.invoke`.
 * @returns The requested subagent name and the originating tool call, if any.
 */
export function readSubagentType(input: unknown): {
  subagentType?: string;
  toolCallId?: string;
} {
  if (!isRecord(input)) {
    return {};
  }
  const fromToolNode = input.type === "tool_call" && isRecord(input.args);
  const args = fromToolNode ? (input.args as Record<string, unknown>) : input;
  return {
    subagentType:
      typeof args.subagent_type === "string" ? args.subagent_type : undefined,
    toolCallId:
      fromToolNode && typeof input.id === "string" ? input.id : undefined,
  };
}

/**
 * Patches one `task` tool in place so general-purpose is neither offered nor
 * dispatchable.
 *
 * In place, and not a clone, for the reason in the module comment: the REPL
 * bridge and ToolNode both hold this object, and LangChain refuses a
 * substitution.
 *
 * The refusal takes the form each caller can act on, which is not the same
 * form. A model tool call gets an error ToolMessage: throwing there ends the
 * run, because ToolNode classifies anything raised under a `wrapToolCall` -
 * and DeepAgents always installs one - as a middleware error and rethrows it
 * past `handleToolErrors`, so a bad `subagentType` would discard a wiki instead
 * of costing a turn. The REPL gets a rejection, because its `task()` returns a
 * promise into guest code: a refusal string would arrive as though the subagent
 * had produced it, and be parsed, indexed, or written into a page.
 *
 * @param taskTool - The registered subagent task tool.
 */
export function applyGeneralPurposeGuard(taskTool: GuardableTaskTool): void {
  taskTool.description = stripGeneralPurpose(taskTool.description);

  const dispatch = taskTool.invoke.bind(taskTool);
  taskTool.invoke = async (input: unknown, config?: unknown) => {
    const { subagentType, toolCallId } = readSubagentType(input);
    if (subagentType !== GENERAL_PURPOSE) {
      return dispatch(input, config);
    }
    if (toolCallId === undefined) {
      throw new Error(REFUSAL);
    }
    return new ToolMessage({
      content: REFUSAL,
      name: taskTool.name,
      status: "error",
      tool_call_id: toolCallId,
    });
  };
}

/**
 * Creates the middleware that applies the guard once per agent.
 *
 * `wrapModelCall` is the hook because `request.tools` is the only place the
 * task tool is exposed - it is contributed by DeepAgents' subagent middleware
 * and never appears on the agent's own tool list. This is the same source
 * `@langchain/quickjs` and {@link createOpenWikiAuthoringPoolMiddleware} read
 * it from.
 *
 * A missing task tool throws. The guard's only failure mode worth defending
 * against is applying to nothing while a run proceeds as though the boundary
 * held, so it fails at the first model call instead.
 *
 * @returns LangChain middleware that disables the general-purpose subagent.
 */
export function createOpenWikiGeneralPurposeGuardMiddleware() {
  let guarded: GuardableTaskTool | null = null;

  return createMiddleware({
    name: "OpenWikiGeneralPurposeGuardMiddleware",
    wrapModelCall: (request, handler) => {
      if (!guarded) {
        const found = (request.tools ?? []).find(
          (candidate: { name?: string }) => candidate.name === "task",
        );
        if (!found) {
          throw new Error(
            "Disabling the general-purpose subagent requires the subagent task tool.",
          );
        }
        guarded = found as unknown as GuardableTaskTool;
        applyGeneralPurposeGuard(guarded);
      }
      return handler(request);
    },
  });
}

/**
 * Narrows an unknown value to a non-array object record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
