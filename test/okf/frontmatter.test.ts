import type { BackendProtocolV2 } from "deepagents";
import { describe, expect, test, vi } from "vitest";
import {
  deriveMinimalFrontmatter,
  normalizeConceptContent,
  parseFrontmatterFields,
  readFrontmatterField,
  removeFrontmatterField,
  renderFrontmatter,
  setFrontmatterField,
  splitFrontmatter,
  validateOkfFrontmatter,
  validatePersistedFile,
} from "../../src/okf/frontmatter.ts";

const PATH = "/openwiki/architecture/overview.md";

describe("normalizeConceptContent", () => {
  test("regenerates front matter for a page that has none", () => {
    const result = normalizeConceptContent(
      "# Architecture Overview\nThis describes the platform.\n",
      PATH,
    );

    expect(result.changed).toBe(true);
    expect(result.content).toContain('type: "Reference"');
    expect(result.content).toContain('title: "Architecture Overview"');
    // description is intentionally not derived; the agent supplies it later
    expect(result.content).not.toContain("description:");
    expect(result.content).toContain("openwiki_generated: true");
    // the original body survives after the injected block
    expect(result.content).toContain("# Architecture Overview");
  });

  test("leaves a valid page untouched", () => {
    const content =
      '---\ntype: "Reference"\ntitle: "Overview"\ndescription: "Body."\n---\n\n# Overview\n';
    const result = normalizeConceptContent(content, PATH);

    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
  });

  test("keeps a page that has a usable type even when optional fields are junk", () => {
    // A valid `type` plus a non-string title is tolerated, not clobbered (#376).
    const content =
      "---\ntype: Domain\ntitle: 123\ndescription: [one, two]\ncustom_ext: keep-me\n---\n\n# Orders\n";
    const result = normalizeConceptContent(content, PATH);

    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
    // the producer extension field is preserved because nothing was rewritten
    expect(result.content).toContain("custom_ext: keep-me");
  });

  test("regenerates a page whose front matter has no type", () => {
    const result = normalizeConceptContent(
      "---\ntitle: Orphan\n---\n\n# Orphan\nSome prose.\n",
      PATH,
    );

    expect(result.changed).toBe(true);
    expect(result.content).toContain('type: "Reference"');
    expect(result.content).toContain("openwiki_generated: true");
  });

  test("stamps a supplied localized concept type on a repaired page", () => {
    const result = normalizeConceptContent(
      "# 架构概览\n描述平台。\n",
      PATH,
      "参考",
    );

    expect(result.changed).toBe(true);
    expect(result.content).toContain('type: "参考"');
    expect(result.content).not.toContain('type: "Reference"');
  });

  test("regenerates unparseable YAML instead of throwing", () => {
    const result = normalizeConceptContent(
      "---\ntype: [unterminated\n---\n\n# Broken\nProse.\n",
      PATH,
    );

    expect(result.changed).toBe(true);
    expect(result.content).toContain('type: "Reference"');
    expect(result.content).toContain("openwiki_generated: true");
  });

  test("regenerates duplicate-key YAML instead of throwing", () => {
    const result = normalizeConceptContent(
      "---\ntype: Reference\ndescription: First\ndescription: Second\n---\n\n# Dupes\n",
      PATH,
    );

    expect(result.changed).toBe(true);
    expect(result.content).toContain("openwiki_generated: true");
  });

  test("carries a pending-translation marker across a regeneration", () => {
    // A non-conformant page (no type) is rebuilt, which drops extension fields;
    // the translation marker must survive so the page is still retried.
    const result = normalizeConceptContent(
      '---\ntitle: Orphan\nopenwiki_translation_pending: "zh-CN"\n---\n\n# Orphan\n',
      PATH,
    );

    expect(result.changed).toBe(true);
    expect(result.content).toContain('type: "Reference"');
    expect(result.content).toContain("openwiki_generated: true");
    expect(result.content).toContain('openwiki_translation_pending: "zh-CN"');
  });

  test("preserves a pending-translation marker on a valid page for free", () => {
    const content =
      '---\ntype: "参考"\nopenwiki_translation_pending: "zh-CN"\n---\n\n# X\n';
    const result = normalizeConceptContent(content, PATH);

    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
  });
});

describe("setFrontmatterField", () => {
  test("inserts a new field, preserving other lines and extensions", () => {
    const result = setFrontmatterField(
      "---\ntype: Reference\ncustom_ext: keep-me\n---\n\n# Page\n",
      "openwiki_translation_pending",
      "zh-CN",
    );

    expect(result).toBe(
      '---\ntype: Reference\ncustom_ext: keep-me\nopenwiki_translation_pending: "zh-CN"\n---\n\n# Page\n',
    );
  });

  test("replaces an existing field's value in place", () => {
    const result = setFrontmatterField(
      '---\ntype: Reference\nopenwiki_translation_pending: "en"\n---\n\n# Page\n',
      "openwiki_translation_pending",
      "hi",
    );

    expect(result).toBe(
      '---\ntype: Reference\nopenwiki_translation_pending: "hi"\n---\n\n# Page\n',
    );
  });

  test("prepends a minimal block when the page has no front matter", () => {
    expect(
      setFrontmatterField(
        "# Page\nBody.\n",
        "openwiki_translation_pending",
        "hi",
      ),
    ).toBe('---\nopenwiki_translation_pending: "hi"\n---\n\n# Page\nBody.\n');
  });

  test("quotes the value so special characters stay safe", () => {
    expect(
      setFrontmatterField("---\ntype: Reference\n---\n\n# P\n", "note", "a: b"),
    ).toContain('note: "a: b"');
  });
});

describe("removeFrontmatterField", () => {
  test("removes a field while preserving the other lines", () => {
    expect(
      removeFrontmatterField(
        '---\ntype: Reference\nopenwiki_translation_pending: "zh-CN"\ntitle: Page\n---\n\n# Page\n',
        "openwiki_translation_pending",
      ),
    ).toBe("---\ntype: Reference\ntitle: Page\n---\n\n# Page\n");
  });

  test("returns the content unchanged when the field is absent", () => {
    const content = "---\ntype: Reference\n---\n\n# Page\n";
    expect(
      removeFrontmatterField(content, "openwiki_translation_pending"),
    ).toBe(content);
  });

  test("returns the content unchanged when there is no block", () => {
    const content = "# Page\nNo front matter.\n";
    expect(
      removeFrontmatterField(content, "openwiki_translation_pending"),
    ).toBe(content);
  });

  test("drops a block that becomes empty", () => {
    expect(
      removeFrontmatterField(
        '---\nopenwiki_translation_pending: "hi"\n---\n\n# Page\n',
        "openwiki_translation_pending",
      ),
    ).toBe("# Page\n");
  });
});

describe("readFrontmatterField", () => {
  test("reads a string field's value", () => {
    expect(
      readFrontmatterField(
        '---\nopenwiki_translation_pending: "zh-CN"\n---\n\n# Page\n',
        "openwiki_translation_pending",
      ),
    ).toBe("zh-CN");
  });

  test("returns undefined when the field is absent or there is no block", () => {
    expect(
      readFrontmatterField("---\ntype: Reference\n---\n", "missing"),
    ).toBeUndefined();
    expect(readFrontmatterField("# Page\n", "type")).toBeUndefined();
  });

  test("returns undefined for a non-string value", () => {
    expect(
      readFrontmatterField("---\ncount: 3\n---\n", "count"),
    ).toBeUndefined();
  });
});

describe("deriveMinimalFrontmatter", () => {
  test("takes the title from the first H1", () => {
    expect(
      deriveMinimalFrontmatter("# Real Title\n\nProse.\n", PATH).title,
    ).toBe("Real Title");
  });

  test("falls back to a humanized filename when there is no H1", () => {
    expect(
      deriveMinimalFrontmatter(
        "Just prose, no heading.\n",
        "/openwiki/operations/credentials-and-updates.md",
      ).title,
    ).toBe("Credentials and updates");
  });

  test("derives only type and title, never a description", () => {
    // description is optional in OKF and left for the agent to write well.
    expect(
      deriveMinimalFrontmatter(
        "# Architecture Overview\nThis describes the platform.\n",
        PATH,
      ),
    ).toEqual({ type: "Reference", title: "Architecture Overview" });
  });

  test("defaults the type to Reference", () => {
    expect(deriveMinimalFrontmatter("body", PATH).type).toBe("Reference");
  });

  test("uses a supplied localized concept type", () => {
    expect(deriveMinimalFrontmatter("body", PATH, "参考").type).toBe("参考");
  });
});

describe("splitFrontmatter", () => {
  test("separates a leading block from the body", () => {
    // splitFrontmatter preserves the body verbatim; the regex consumes only one
    // newline after the closing fence, so the blank line here stays in the body.
    const { block, body } = splitFrontmatter(
      "---\ntype: Reference\n---\n\n# Page\n",
    );
    expect(block).toBe("type: Reference");
    expect(body).toBe("\n# Page\n");
  });

  test("returns the whole content as body when there is no block", () => {
    const { block, body } = splitFrontmatter("# Page\nNo front matter.\n");
    expect(block).toBeUndefined();
    expect(body).toBe("# Page\nNo front matter.\n");
  });
});

describe("parseFrontmatterFields", () => {
  test("parses a valid mapping", () => {
    expect(
      parseFrontmatterFields("---\ntype: Reference\ntitle: Page\n---\n"),
    ).toEqual({ type: "Reference", title: "Page" });
  });

  test("returns undefined when there is no block", () => {
    expect(parseFrontmatterFields("# Page\n")).toBeUndefined();
  });

  test("returns undefined for unparseable YAML", () => {
    expect(
      parseFrontmatterFields("---\ntype: [unterminated\n---\n"),
    ).toBeUndefined();
  });

  test("returns undefined for duplicate keys", () => {
    expect(parseFrontmatterFields("---\na: 1\na: 2\n---\n")).toBeUndefined();
  });

  test("returns undefined for a non-mapping root", () => {
    expect(parseFrontmatterFields("---\n- one\n- two\n---\n")).toBeUndefined();
  });
});

describe("validateOkfFrontmatter non-mapping root", () => {
  test("rejects front matter whose YAML root is not a mapping", () => {
    // A scalar or list parses cleanly but is not an OKF field map, so it is
    // reported distinctly from a YAML syntax error.
    for (const block of ["just a scalar", "- one\n- two"]) {
      expect(validateOkfFrontmatter(`---\n${block}\n---\n`)).toMatchObject({
        issues: [{ code: "invalid_yaml_root" }],
        valid: false,
      });
    }
  });
});

describe("validatePersistedFile", () => {
  function backend(read: {
    error?: string;
    content?: string | string[] | Uint8Array;
  }): BackendProtocolV2 {
    return {
      readRaw: vi.fn(() => ({
        error: read.error,
        data:
          read.content === undefined
            ? undefined
            : {
                content: read.content,
                mimeType: "text/markdown",
                created_at: "2026-07-13T00:00:00.000Z",
                modified_at: "2026-07-13T00:00:00.000Z",
              },
      })),
    } as unknown as BackendProtocolV2;
  }

  test("validates the joined text of a persisted file", async () => {
    await expect(
      validatePersistedFile(
        backend({ content: ["---", "type: Reference", "---", ""] }),
        "/openwiki/page.md",
      ),
    ).resolves.toEqual({ valid: true });
  });

  test("reports a read failure instead of validating missing text", async () => {
    // A read error, absent content, or binary data all mean there is no final
    // Markdown to validate, which is surfaced as a single structured issue.
    for (const read of [
      { error: "boom" },
      { content: undefined },
      { content: new Uint8Array([1, 2, 3]) },
    ]) {
      await expect(
        validatePersistedFile(backend(read), "/openwiki/page.md"),
      ).resolves.toMatchObject({
        issues: [{ code: "file_read_failed" }],
        valid: false,
      });
    }
  });
});

describe("renderFrontmatter", () => {
  test("renders type, title, and the generated mark", () => {
    expect(
      renderFrontmatter(
        { type: "Reference", title: "Page" },
        { generated: true },
      ),
    ).toBe(
      '---\ntype: "Reference"\ntitle: "Page"\nopenwiki_generated: true\n---\n\n',
    );
  });

  test("omits the generated mark when not generated", () => {
    const rendered = renderFrontmatter(
      { type: "Reference", title: "Page" },
      { generated: false },
    );
    expect(rendered).not.toContain("openwiki_generated");
    expect(rendered).not.toContain("description:");
  });

  test("quotes values so colons and special characters are safe", () => {
    expect(
      renderFrontmatter(
        { type: "Reference", title: "A: colon" },
        { generated: false },
      ),
    ).toContain('title: "A: colon"');
  });
});
