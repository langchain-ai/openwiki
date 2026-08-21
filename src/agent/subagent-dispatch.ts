/**
 * Dispatching a subagent from inside a host-side tool.
 *
 * DeepAgents' task tool returns two different things depending on how it was
 * invoked. Without `config.toolCall.id` it returns the subagent's final message
 * as a string; with one it returns a Command carrying a state update, because
 * that is how a model-invoked tool writes messages back into the graph.
 *
 * A host-side tool that dispatches subagents wants the string, always -
 * otherwise which shape it receives depends on how the dispatching tool happens
 * to be registered: a PTC tool called from inside the REPL has no toolCall in
 * its config, while an ordinary model tool does, and stringifying a Command
 * yields "[object Object]" rather than failing.
 *
 * So the toolCall is stripped here, and the Command form is unwrapped anyway in
 * case some other path still produces one.
 */

/** The subagent task tool, narrowed to what dispatching needs. */
export interface TaskToolLike {
  invoke: (input: unknown, config?: unknown) => Promise<unknown>;
}

/**
 * Dispatches one subagent and returns its final message as text.
 *
 * @param taskTool - DeepAgents' task tool, found from `request.tools`.
 * @param subagentType - Registered subagent name.
 * @param description - The task, complete in itself.
 * @param config - The calling tool's config.
 * @returns The subagent's final message.
 */
export async function dispatchSubagent(
  taskTool: TaskToolLike,
  subagentType: string,
  description: string,
  config: unknown,
): Promise<string> {
  // Without a toolCall the task tool returns text rather than a Command.
  const withoutToolCall = { ...(config as object), toolCall: undefined };
  const result = await taskTool.invoke(
    { description, subagent_type: subagentType },
    withoutToolCall,
  );
  return unwrapSubagentResult(result);
}

/**
 * Reads the subagent's text out of whichever shape the task tool returned.
 *
 * @param result - Raw task tool result.
 * @returns The final message as text.
 */
export function unwrapSubagentResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  const messages = (result as { update?: { messages?: unknown[] } } | null)
    ?.update?.messages;
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  const content = (last as { content?: unknown } | null)?.content;
  if (typeof content === "string") {
    return content;
  }
  // Content blocks: the text ones concatenated, which is what DeepAgents does
  // when it renders a subagent's final message itself.
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" && block !== null && "text" in block
          ? String((block as { text: unknown }).text)
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return typeof result === "object" && result !== null
    ? JSON.stringify(result)
    : String(result);
}
