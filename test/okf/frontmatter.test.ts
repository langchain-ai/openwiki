import type { BackendProtocolV2 } from "deepagents";
import { describe, expect, test, vi } from "vitest";
import {
  deriveMinimalFrontmatter,
  normalizeConceptContent,
  parseFrontmatterFields,
  readFrontmatterField,
  removeFrontmatterField,
  repairOkfFrontmatter,
  repairPersistedFile,
  renderFrontmatter,
  setFrontmatterField,
  setGeneratedEvent,
  setOkfSources,
  setOkfVerified,
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

  test("repairs optional fields while preserving producer extensions", () => {
    const content =
      "---\ntype: Domain\ntitle: 123\ndescription: [one, two]\ncustom_ext: keep-me\n---\n\n# Orders\n";
    const result = normalizeConceptContent(content, PATH);

    expect(result.changed).toBe(true);
    expect(parseFrontmatterFields(result.content)).toMatchObject({
      custom_ext: "keep-me",
      title: "Orders",
      type: "Domain",
    });
    expect(result.content).not.toContain("description:");
    expect(result.content).toContain("custom_ext: keep-me");
    expect(validateOkfFrontmatter(result.content)).toEqual({ valid: true });
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

  test("carries a code-owned generated event across a regeneration", () => {
    // A type-less page is rebuilt, which drops front matter. The deterministic
    // `generated` provenance must survive verbatim so a stamped page does not
    // lose its recorded last-change time when it also trips the repair path.
    const result = normalizeConceptContent(
      '---\ntitle: Orphan\ngenerated: {by: "openwiki/0.3.1", at: "2026-08-18T09:00:00.000Z"}\n---\n\n# Orphan\n',
      PATH,
    );

    expect(result.changed).toBe(true);
    expect(result.content).toContain('type: "Reference"');
    expect(result.content).toContain("openwiki_generated: true");
    expect(result.content).toContain(
      'generated: {by: "openwiki/0.3.1", at: "2026-08-18T09:00:00.000Z"}',
    );
    // The carried event is still valid OKF on the rebuilt page.
    expect(validateOkfFrontmatter(result.content)).toEqual({ valid: true });
  });

  test("carries a multiline sources list across a regeneration", () => {
    const result = normalizeConceptContent(
      "---\ntitle: Orphan\nsources:\n  - id: repo-readme\n    resource: repo://README.md\n---\n\n# Orphan\n",
      PATH,
    );

    expect(result.changed).toBe(true);
    expect(result.content).toContain("sources:\n  - id: repo-readme");
    expect(result.content).toContain("resource: repo://README.md");
    expect(validateOkfFrontmatter(result.content)).toEqual({ valid: true });
  });

  test("carries a multiline verified list across a regeneration", () => {
    const result = normalizeConceptContent(
      "---\ntitle: Orphan\nverified:\n  - by: human:reviewer\n    at: 2026-08-20T12:00:00.000Z\n---\n\n# Orphan\n",
      PATH,
    );

    expect(result.content).toContain("verified:\n  - by: human:reviewer");
    expect(validateOkfFrontmatter(result.content)).toEqual({ valid: true });
  });
});

describe("repairOkfFrontmatter", () => {
  test.each([
    {
      field: "type",
      yaml: "type: [Reference]",
      expected: {
        openwiki_generated: true,
        title: "Page",
        type: "Referenca",
      },
    },
    {
      field: "title",
      yaml: "type: Guide\ntitle: 42",
      expected: { title: "Page", type: "Guide" },
    },
    {
      field: "description",
      yaml: "type: Guide\ndescription: [invalid]",
      absent: "description",
    },
    {
      field: "resource",
      yaml: "type: Guide\nresource: {invalid: true}",
      absent: "resource",
    },
    {
      field: "timestamp",
      yaml: "type: Guide\ntimestamp: []",
      absent: "timestamp",
    },
    {
      field: "tags",
      yaml: 'type: Guide\ntags: [docs, 7, "", api]',
      expected: { tags: ["docs", "api"] },
    },
    {
      field: "generated",
      yaml: "type: Guide\ngenerated: {at: 2026-08-20T00:00:00Z}",
      absent: "generated",
    },
    {
      field: "verified",
      yaml: "type: Guide\nverified:\n  - {by: human:reviewer, at: 2026-08-20T00:00:00Z}\n  - {by: human:broken, at: someday}",
      expected: {
        verified: [{ by: "human:reviewer", at: "2026-08-20T00:00:00Z" }],
      },
    },
    {
      field: "sources",
      yaml: "type: Guide\nsources:\n  - {id: good, resource: repo://README.md}\n  - {id: missing-resource}",
      expected: {
        sources: [{ id: "good", resource: "repo://README.md" }],
      },
    },
    {
      field: "status",
      yaml: "type: Guide\nstatus: reviewed",
      absent: "status",
    },
    {
      field: "stale_after",
      yaml: "type: Guide\nstale_after: someday",
      absent: "stale_after",
    },
  ])("deterministically degrades invalid $field metadata", (fixture) => {
    const content = `---\n${fixture.yaml}\nproducer_extension: keep\n---\n\n# Page\n\nAuthored body.\n`;
    const repaired = repairOkfFrontmatter(content, PATH, "Referenca");
    const fields = parseFrontmatterFields(repaired.content);

    expect(repaired.changed).toBe(true);
    expect(fields).toMatchObject({
      producer_extension: "keep",
      ...(fixture.expected ?? {}),
    });
    if (fixture.absent) expect(fields).not.toHaveProperty(fixture.absent);
    expect(repaired.content).toContain("# Page\n\nAuthored body.\n");
    expect(validateOkfFrontmatter(repaired.content)).toEqual({ valid: true });
  });

  test("falls back to minimal valid metadata for an unusable YAML mapping", () => {
    const repaired = repairOkfFrontmatter(
      "---\ntype: Guide\ntype: Domain\n---\n\n# Page\n\nBody.\n",
      PATH,
    );

    expect(parseFrontmatterFields(repaired.content)).toEqual({
      openwiki_generated: true,
      title: "Page",
      type: "Reference",
    });
    expect(repaired.content).toContain("# Page\n\nBody.\n");
    expect(validateOkfFrontmatter(repaired.content)).toEqual({ valid: true });
  });
});

describe("setOkfSources", () => {
  test("adds a structured sources list without rewriting sibling fields", () => {
    const result = setOkfSources(
      '---\ntype: Reference\ngenerated: {by: "openwiki/0.3.3"}\ncustom: keep\n---\n\n# Page\n',
      [
        {
          id: "openwiki-source-one",
          resource: "repo://src/page.ts#L1-L4",
        },
      ],
    );

    expect(result).toContain(
      'generated: {by: "openwiki/0.3.3"}\ncustom: keep\nsources:',
    );
    expect(parseFrontmatterFields(result)?.sources).toEqual([
      {
        id: "openwiki-source-one",
        resource: "repo://src/page.ts#L1-L4",
      },
    ]);
    expect(validateOkfFrontmatter(result)).toEqual({ valid: true });
  });

  test("replaces every continuation line and removes an empty list", () => {
    const original =
      "---\ntype: Reference\nsources:\n  - id: old\n    resource: repo://old.ts\ntitle: Page\n---\n\n# Page\n";
    const replaced = setOkfSources(original, [
      { id: "new", resource: "repo://new.ts" },
    ]);

    expect(replaced).not.toContain("repo://old.ts");
    expect(replaced).toContain("repo://new.ts");
    expect(replaced).toContain("title: Page");
    expect(setOkfSources(replaced, [])).toBe(
      "---\ntype: Reference\ntitle: Page\n---\n\n# Page\n",
    );
  });
});

describe("setOkfVerified", () => {
  test("replaces a multiline event list without rewriting sibling fields", () => {
    const original =
      "---\ntype: Reference\nverified:\n  - by: openwiki/0.3.2\n    at: old\ncustom: keep\n---\n\n# Page\n";
    const result = setOkfVerified(original, [
      { by: "human:reviewer", at: "2026-08-20T11:00:00.000Z" },
      { by: "openwiki/0.3.3", at: "2026-08-20T12:00:00.000Z" },
    ]);

    expect(result).not.toContain("openwiki/0.3.2");
    expect(result).toContain("custom: keep");
    expect(parseFrontmatterFields(result)?.verified).toEqual([
      { by: "human:reviewer", at: "2026-08-20T11:00:00.000Z" },
      { by: "openwiki/0.3.3", at: "2026-08-20T12:00:00.000Z" },
    ]);
    expect(setOkfVerified(result, [])).not.toContain("verified:");
  });
});

describe("setGeneratedEvent", () => {
  test("appends a generated flow mapping, preserving other lines", () => {
    expect(
      setGeneratedEvent(
        "---\ntype: Reference\ntitle: Page\n---\n\n# Page\n",
        "openwiki/0.3.1",
        "2026-08-18T09:00:00.000Z",
      ),
    ).toBe(
      '---\ntype: Reference\ntitle: Page\ngenerated: { by: "openwiki/0.3.1", at: "2026-08-18T09:00:00.000Z" }\n---\n\n# Page\n',
    );
  });

  test("replaces an existing generated event in place", () => {
    expect(
      setGeneratedEvent(
        '---\ntype: Reference\ngenerated: {by: "human:steve"}\ntitle: Page\n---\n\n# Page\n',
        "openwiki/0.3.1",
        "2026-08-18T09:00:00.000Z",
      ),
    ).toBe(
      '---\ntype: Reference\ngenerated: { by: "openwiki/0.3.1", at: "2026-08-18T09:00:00.000Z" }\ntitle: Page\n---\n\n# Page\n',
    );
  });

  test("replaces a multiline generated mapping as one complete field", () => {
    const stamped = setGeneratedEvent(
      '---\ntype: Reference\ngenerated:\n  by: openwiki/0.3.0\n  at: "2026-08-17T09:00:00.000Z"\ntitle: Page\n---\n\n# Page\n',
      "openwiki/0.3.1",
      "2026-08-18T09:00:00.000Z",
    );

    expect(stamped).toBe(
      '---\ntype: Reference\ngenerated: { by: "openwiki/0.3.1", at: "2026-08-18T09:00:00.000Z" }\ntitle: Page\n---\n\n# Page\n',
    );
    expect(validateOkfFrontmatter(stamped)).toEqual({ valid: true });
  });

  test("emits a bare {by} event when no time is supplied", () => {
    expect(
      setGeneratedEvent(
        "---\ntype: Reference\n---\n\n# Page\n",
        "openwiki/0.3.1",
      ),
    ).toBe(
      '---\ntype: Reference\ngenerated: { by: "openwiki/0.3.1" }\n---\n\n# Page\n',
    );
  });

  test("prepends a minimal block when the page has no front matter", () => {
    expect(
      setGeneratedEvent(
        "# Page\nBody.\n",
        "openwiki/0.3.1",
        "2026-08-18T09:00:00.000Z",
      ),
    ).toBe(
      '---\ngenerated: { by: "openwiki/0.3.1", at: "2026-08-18T09:00:00.000Z" }\n---\n\n# Page\nBody.\n',
    );
  });

  test("produces front matter the validator accepts", () => {
    const stamped = setGeneratedEvent(
      "---\ntype: Reference\n---\n\n# Page\n",
      "openwiki/0.3.1",
      "2026-08-18T09:00:00.000Z",
    );
    expect(validateOkfFrontmatter(stamped)).toEqual({ valid: true });
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

  test("removes a complete multiline mapping", () => {
    expect(
      removeFrontmatterField(
        '---\ntype: Reference\ngenerated:\n  by: openwiki/0.3.0\n  at: "2026-08-17T09:00:00.000Z"\ntitle: Page\n---\n\n# Page\n',
        "generated",
      ),
    ).toBe("---\ntype: Reference\ntitle: Page\n---\n\n# Page\n");
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

describe("repairPersistedFile", () => {
  test("writes and re-validates a deterministic repair", async () => {
    let content =
      "---\ntype: Guide\nstatus: reviewed\n---\n\n# Page\n\nBody.\n";
    const backend = {
      readRaw: vi.fn(() => ({
        data: {
          content,
          mimeType: "text/markdown",
          created_at: "2026-07-13T00:00:00.000Z",
          modified_at: "2026-07-13T00:00:00.000Z",
        },
      })),
      write: vi.fn((_path: string, next: string) => {
        content = next;
        return {};
      }),
    } as unknown as BackendProtocolV2;

    await expect(
      repairPersistedFile(backend, "/openwiki/page.md"),
    ).resolves.toEqual({ changed: true, validation: { valid: true } });
    expect(content).not.toContain("status:");
    expect(content).toContain("# Page\n\nBody.\n");
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
