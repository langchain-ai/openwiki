import { ToolMessage } from "langchain";
import { describe, expect, it } from "vitest";
import {
  classifyRecoverableFileToolSchemaError,
  createFileToolSchemaRecoveryMiddleware,
} from "../src/agent/index.js";

describe("classifyRecoverableFileToolSchemaError", () => {
  it("recognizes write_file schema errors and describes the required arguments", () => {
    const error = new Error(
      "Received tool input did not match expected schema\nInvalid input: expected string, received undefined\n  -> at file_path",
    );

    expect(
      classifyRecoverableFileToolSchemaError("write_file", error),
    ).toMatchObject({
      toolName: "write_file",
      requiredArguments: ["file_path", "content"],
    });
  });

  it("ignores non-schema execution errors", () => {
    const error = new Error("ENOENT: no such file or directory");

    expect(classifyRecoverableFileToolSchemaError("write_file", error)).toBeNull();
  });
});

describe("createFileToolSchemaRecoveryMiddleware", () => {
  it("turns recoverable schema failures into an error ToolMessage", async () => {
    const middleware = createFileToolSchemaRecoveryMiddleware();
    const wrapToolCall = middleware.wrapToolCall;

    expect(wrapToolCall).toBeTypeOf("function");

    const result = await wrapToolCall!(
      {
        toolCall: {
          id: "call_123",
          name: "write_file",
          args: {},
        },
      } as never,
      async () => {
        throw new Error(
          "Received tool input did not match expected schema\nInvalid input: expected string, received undefined\n  -> at file_path",
        );
      },
    );

    expect(ToolMessage.isInstance(result)).toBe(true);
    expect(result).toMatchObject({
      status: "error",
      tool_call_id: "call_123",
    });
    expect(result.content).toContain("write_file");
    expect(result.content).toContain("file_path");
    expect(result.content).toContain("content");
  });
});
