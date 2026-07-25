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

  test("derives only type and title, never a description", () => {
    // description is optional in OKF and left for the agent to write well.
    expect(
      deriveMinimalFrontmatter(
        "# Architecture Overview\nThis describes the platform.\n",
        PATH,
      ),
    ).toEqual({ type: "Reference", title: "Architecture Overview" });
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
