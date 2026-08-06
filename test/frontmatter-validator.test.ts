import { ToolMessage } from "@langchain/core/messages";
import type { BackendProtocolV2 } from "deepagents";
import { describe, expect, test, vi } from "vitest";
import { MUTATION_PATH_METADATA_KEY } from "../src/agent/docs-only-backend.ts";
import { addFrontmatterWarning } from "../src/agent/okf-middleware.ts";
import { validateOkfFrontmatter } from "../src/okf/frontmatter.ts";

function markdown(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n\n# Page\n`;
}

function backendWith(content: string) {
  return {
    readRaw: vi.fn(() => ({
      data: {
        content,
        created_at: "2026-07-13T00:00:00.000Z",
        mimeType: "text/markdown",
        modified_at: "2026-07-13T00:00:00.000Z",
      },
    })),
  } satisfies Pick<BackendProtocolV2, "readRaw">;
}

function mutationMessage(path = "/openwiki/page.md") {
  return new ToolMessage({
    content: "Successfully wrote file.",
    metadata: { [MUTATION_PATH_METADATA_KEY]: path },
    tool_call_id: "write-1",
  });
}

describe("validateOkfFrontmatter", () => {
  test("accepts the required type and supported optional fields", () => {
    expect(validateOkfFrontmatter(markdown("type: Reference"))).toEqual({
      valid: true,
    });
    expect(
      validateOkfFrontmatter(
        markdown(
          [
            "type: API Endpoint",
            'title: "Create order"',
            "description: >-",
            "  Creates a completed",
            "  order.",
            "resource: https://example.com/orders",
            "tags:",
            "  - api",
            "  - orders",
          ].join("\n"),
        ),
      ),
    ).toEqual({ valid: true });
  });

  test("accepts OKF timestamp and producer-defined extension fields", () => {
    expect(
      validateOkfFrontmatter(
        markdown(
          [
            "type: Reference",
            'timestamp: "2026-07-16T20:00:00Z"',
            "author: steve",
            "confidence: 0.95",
            "status: verified",
          ].join("\n"),
        ),
      ),
    ).toEqual({ valid: true });
  });

  test("reports deterministic delimiter and required-field issues", () => {
    expect(validateOkfFrontmatter("# Page")).toEqual({
      issues: [
        {
          code: "missing_opening_delimiter",
          line: 1,
          message: "File must begin with `---`.",
        },
      ],
      valid: false,
    });
    expect(validateOkfFrontmatter("---\ntype: Reference")).toMatchObject({
      issues: [{ code: "missing_closing_delimiter" }],
      valid: false,
    });
    expect(validateOkfFrontmatter(markdown("title: Page"))).toMatchObject({
      issues: [{ code: "missing_type" }],
      valid: false,
    });
  });

  test("reports malformed and duplicate YAML", () => {
    for (const frontmatter of [
      "type: [unterminated",
      "type: Reference\ntype: Playbook",
    ]) {
      expect(validateOkfFrontmatter(markdown(frontmatter))).toMatchObject({
        issues: [{ code: "invalid_yaml" }],
        valid: false,
      });
    }
    const malformed = validateOkfFrontmatter(
      markdown("type: Reference\ndescription: [unterminated"),
    );
    if (malformed.valid) throw new Error("Expected invalid YAML.");
    expect(malformed.issues[0].message).toContain("line 3");
  });

  test("reports mistyped standard fields", () => {
    const result = validateOkfFrontmatter(
      markdown(
        [
          "type: Reference",
          "timestamp: [Not a string]",
          "title: [Not a string]",
          "description: 123",
          "tags: docs, api",
          "producer_extension: preserved",
        ].join("\n"),
      ),
    );

    expect(result).toMatchObject({
      issues: [
        { code: "invalid_title" },
        { code: "invalid_description" },
        { code: "invalid_timestamp" },
        { code: "invalid_tags" },
      ],
      valid: false,
    });
  });
});

describe("addFrontmatterWarning", () => {
  test("appends actionable validation details after an invalid wiki write", async () => {
    const message = mutationMessage();
    await addFrontmatterWarning(
      message,
      backendWith("# Missing front matter"),
      "repository",
      "write_file",
    );

    expect(message.content).toContain(
      "YAML front matter was NOT formatted properly",
    );
    expect(message.content).toContain("[missing_opening_delimiter] line 1");
    expect(message.content).toContain("MUST correct this file");
  });

  test("leaves valid files and unrelated tool calls unchanged", async () => {
    const validMessage = mutationMessage();
    const validBackend = backendWith(markdown("type: Reference"));
    await addFrontmatterWarning(
      validMessage,
      validBackend,
      "repository",
      "edit_file",
    );
    expect(validMessage.content).toBe("Successfully wrote file.");

    const outsideMessage = mutationMessage("/README.md");
    const outsideBackend = backendWith("invalid");
    await addFrontmatterWarning(
      outsideMessage,
      outsideBackend,
      "repository",
      "write_file",
    );
    expect(outsideBackend.readRaw).not.toHaveBeenCalled();

    await addFrontmatterWarning(
      mutationMessage(),
      outsideBackend,
      "repository",
      "read_file",
    );
    expect(outsideBackend.readRaw).not.toHaveBeenCalled();
  });

  test("does not validate reserved index and log documents as concepts", async () => {
    for (const fileName of ["index.md", "log.md"]) {
      const backend = backendWith("# Reserved OKF document");
      const message = mutationMessage(`/openwiki/architecture/${fileName}`);

      await addFrontmatterWarning(message, backend, "repository", "write_file");

      expect(backend.readRaw).not.toHaveBeenCalled();
      expect(message.content).toBe("Successfully wrote file.");
    }
  });

  test("edits tool messages nested in Command results", async () => {
    const message = mutationMessage();
    const command = { update: { messages: [message] } };
    await addFrontmatterWarning(
      command,
      backendWith(markdown("title: Missing type")),
      "repository",
      "edit_file",
    );

    expect(message.content).toContain("[missing_type]");
  });
});
