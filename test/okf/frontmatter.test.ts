import { describe, expect, test } from "vitest";
import {
  deriveMinimalFrontmatter,
  normalizeConceptContent,
  parseFrontmatterFields,
  renderFrontmatter,
  splitFrontmatter,
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
    expect(result.content).toContain(
      'description: "This describes the platform."',
    );
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

  test("takes the description from prose directly under the heading (no blank line)", () => {
    // The #386 shape: heading immediately followed by prose.
    expect(
      deriveMinimalFrontmatter(
        "# Architecture Overview\nThis describes the platform.\n",
        PATH,
      ).description,
    ).toBe("This describes the platform.");
  });

  test("collapses a multi-line paragraph into one line", () => {
    expect(
      deriveMinimalFrontmatter(
        "# Title\n\nLine one\nline two\n\nLater paragraph.\n",
        PATH,
      ).description,
    ).toBe("Line one line two");
  });

  test("omits the description for a heading-only page", () => {
    expect(deriveMinimalFrontmatter("# Only A Heading\n", PATH)).toEqual({
      type: "Reference",
      title: "Only A Heading",
    });
  });

  test("always uses type Reference", () => {
    expect(deriveMinimalFrontmatter("body", PATH).type).toBe("Reference");
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

describe("renderFrontmatter", () => {
  test("renders type, title, description, and the generated mark", () => {
    expect(
      renderFrontmatter(
        { type: "Reference", title: "Page", description: "A page." },
        { generated: true },
      ),
    ).toBe(
      '---\ntype: "Reference"\ntitle: "Page"\ndescription: "A page."\nopenwiki_generated: true\n---\n\n',
    );
  });

  test("omits the description line when there is none", () => {
    const rendered = renderFrontmatter(
      { type: "Reference", title: "Page" },
      { generated: false },
    );
    expect(rendered).not.toContain("description:");
    expect(rendered).not.toContain("openwiki_generated");
  });

  test("quotes values so colons and special characters are safe", () => {
    expect(
      renderFrontmatter(
        { type: "Reference", title: "A: colon", description: 'has "quotes"' },
        { generated: false },
      ),
    ).toContain('title: "A: colon"');
  });
});
