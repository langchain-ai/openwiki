import { ToolInputParsingException } from "@langchain/core/tools";
import { createMiddleware, ToolInvocationError, ToolMessage } from "langchain";

/**
 * Recover from malformed tool calls instead of aborting the run.
 *
 * When a tool call's arguments fail schema validation, langchain re-raises and
 * the run dies. This converts that into an error `ToolMessage` so the model can
 * retry. Only schema failures are caught. Runtime tool errors, interrupts, and
 * aborts propagate remain untouched.
 */
export function createToolSchemaRecoveryMiddleware() {
  return createMiddleware({
    name: "OpenWikiToolSchemaRecovery",
    wrapToolCall: async (request, handler) => {
      try {
        return await handler(request);
      } catch (error) {
        // ToolNode wraps a schema-validation failure in a ToolInvocationError
        // (thrown only for ToolInputParsingException); accept the raw exception
        // too in case it ever surfaces unwrapped. Everything else propagates
        // untouched.
        if (
          !(error instanceof ToolInvocationError) &&
          !(error instanceof ToolInputParsingException)
        ) {
          throw error;
        }

        const toolCallId = request.toolCall?.id;

        // Without a tool_call_id we cannot return a parity-valid tool result,
        // so surface the original error rather than fabricate one.
        if (!toolCallId) {
          throw error;
        }

        const toolName = request.toolCall?.name ?? "tool";

        return new ToolMessage({
          content: `The \`${toolName}\` call was rejected because its arguments did not match the tool's schema:\n${error.message}\nRetry the call with arguments that match the schema.`,
          status: "error",
          tool_call_id: toolCallId,
        });
      }
    },
  });
}
