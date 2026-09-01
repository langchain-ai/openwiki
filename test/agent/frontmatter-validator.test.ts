import { ToolMessage } from "@langchain/core/messages";
import { describe, expect, test, vi } from "vitest";
import { MUTATION_PATH_METADATA_KEY } from "../../src/agent/docs-only-backend.ts";
import { addFrontmatterWarning } from "../../src/agent/okf-middleware.ts";
import { validateOkfFrontmatter } from "../../src/okf/frontmatter.ts";

function markdown(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n\n# Page\n`;
}

function backendWith(initialContent: string) {
  let content = initialContent;
  return {
    current: () => content,
    readRaw: vi.fn(() => ({
      data: {
        content,
        created_at: "2026-07-13T00:00:00.000Z",
        mimeType: "text/markdown",
        modified_at: "2026-07-13T00:00:00.000Z",
      },
    })),
    write: vi.fn((_path: string, next: string) => {
      content = next;
      return {};
    }),
  };
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

  test("accepts the legacy v0.1 timestamp and producer-defined extension fields", () => {
    expect(
      validateOkfFrontmatter(
        markdown(
          [
            "type: Reference",
            'timestamp: "2026-07-16T20:00:00Z"',
            "author: steve",
            "confidence: 0.95",
            "review_state: verified",
          ].join("\n"),
        ),
      ),
    ).toEqual({ valid: true });
  });

  test("accepts the v0.2 provenance, trust, and lifecycle families", () => {
    expect(
      validateOkfFrontmatter(
        markdown(
          [
            "type: Reference",
            "generated: {by: openwiki/0.3.0, at: 2026-08-04T09:00:00Z}",
            "verified:",
            "  - {by: human:ahormati, at: 2026-08-05T09:00:00Z}",
            "  - {by: process:finance-nightly, at: 2026-08-06T02:00:00Z}",
            "sources:",
            "  - id: spec",
            "    resource: https://example.com/spec",
            "    author: team:docs",
            "    usage_count: 5000",
            "    last_modified: 2026-05-30T00:00:00Z",
            "usage_window: {from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z}",
            "status: stable",
            "stale_after: 2026-09-23T00:00:00-07:00",
          ].join("\n"),
        ),
      ),
    ).toEqual({ valid: true });
  });

  test("accepts a bare verified mapping as a one-element list", () => {
    // §5.2: a single verifier may be written without the list dash.
    expect(
      validateOkfFrontmatter(
        markdown(
          "type: Reference\nverified: {by: human:ahormati, at: 2026-08-05T09:00:00Z}",
        ),
      ),
    ).toEqual({ valid: true });
  });

  test("rejects timestamps without an explicit UTC offset", () => {
    const result = validateOkfFrontmatter(
      markdown(
        [
          "type: Reference",
          "generated: {by: openwiki/0.3.0, at: 2026-08-04}",
          "verified: {by: human:ahormati, at: 2026-08-05T09:00:00}",
          "stale_after: 2026-09-23",
        ].join("\n"),
      ),
    );

    expect(result).toMatchObject({
      issues: [
        { code: "invalid_generated" },
        { code: "invalid_verified" },
        { code: "invalid_stale_after" },
      ],
      valid: false,
    });
  });

  test("rejects impossible ISO-shaped timestamps", () => {
    const result = validateOkfFrontmatter(
      markdown(
        [
          "type: Reference",
          "generated: {by: openwiki/0.3.0, at: 2026-02-30T09:00:00Z}",
          "verified: {by: human:ahormati, at: 2026-08-05T25:00:00Z}",
          "stale_after: 2026-09-23T00:00:00+24:00",
        ].join("\n"),
      ),
    );

    expect(result).toMatchObject({
      issues: [
        { code: "invalid_generated" },
        { code: "invalid_verified" },
        { code: "invalid_stale_after" },
      ],
      valid: false,
    });
  });

  test("reports malformed v0.2 family fields", () => {
    const result = validateOkfFrontmatter(
      markdown(
        [
          "type: Reference",
          "generated: 2026-08-04",
          "verified:",
          "  - {at: 2026-08-05T09:00:00Z}",
          "sources:",
          "  - {id: spec}",
          "status: verified",
          "stale_after: soon",
        ].join("\n"),
      ),
    );

    expect(result).toMatchObject({
      issues: [
        { code: "invalid_generated" },
        { code: "invalid_verified" },
        { code: "invalid_sources" },
        { code: "invalid_status" },
        { code: "invalid_stale_after" },
      ],
      valid: false,
    });
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
  test("repairs invalid wiki metadata without asking the model to retry", async () => {
    const message = mutationMessage();
    const backend = backendWith("# Missing front matter");
    await addFrontmatterWarning(message, backend, "repository", "write_file");

    expect(message.content).toBe("Successfully wrote file.");
    expect(validateOkfFrontmatter(backend.current())).toEqual({ valid: true });
    expect(backend.current()).toContain("# Missing front matter");
  });

  test("warns when deterministic repair cannot be persisted", async () => {
    const message = mutationMessage();
    const backend = backendWith("# Missing front matter");
    vi.mocked(backend.write).mockResolvedValue({ error: "disk full" });

    await addFrontmatterWarning(message, backend, "repository", "write_file");

    expect(message.content).toContain(
      "could not persist deterministic YAML front matter repair",
    );
    expect(message.content).toContain("[file_write_failed]");
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
    const backend = backendWith(markdown("title: Missing type"));
    await addFrontmatterWarning(command, backend, "repository", "edit_file");

    expect(message.content).toBe("Successfully wrote file.");
    expect(validateOkfFrontmatter(backend.current())).toEqual({ valid: true });
  });
});
