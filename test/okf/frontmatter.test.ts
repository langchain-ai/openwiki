import { describe, expect, test } from "vitest";
import {
  parseFrontmatter,
  serializeFrontmatter,
} from "../../src/agent/okf/frontmatter.ts";

describe("parseFrontmatter", () => {
  test("a --- inside a value does not truncate the block", () => {
    const raw = [
      "---",
      "type: Doc",
      "description: |",
      "  line one",
      "  ---",
      "  line two",
      "title: T",
      "---",
      "# Body",
      "",
    ].join("\n");

    const { data, body } = parseFrontmatter(raw);

    // If the inner "  ---" had truncated the block, `title` would be missing.
    expect(data.type).toBe("Doc");
    expect(data.title).toBe("T");
    expect(body).toBe("# Body\n");
  });

  test("missing frontmatter yields empty data and the full body", () => {
    const parsed = parseFrontmatter("# No frontmatter\n\nBody.\n");

    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe("# No frontmatter\n\nBody.\n");
  });

  test("malformed frontmatter is treated as absent, body preserved", () => {
    const parsed = parseFrontmatter("---\nfoo: [unclosed\n---\nBody.\n");

    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe("Body.\n");
  });
});

describe("serializeFrontmatter", () => {
  test("emits managed keys in fixed order, then preserved unknown keys", () => {
    const output = serializeFrontmatter(
      { timestamp: "t", owner: "platform", title: "T", type: "Doc" },
      "# T\n",
    );

    const keyOrder = output
      .split("\n---")[0]
      .split("\n")
      .filter((line) => /^[a-z_]+:/u.test(line))
      .map((line) => line.split(":")[0]);

    expect(keyOrder).toEqual(["type", "title", "timestamp", "owner"]);
    expect(output).toContain("owner: platform");
  });

  test("is a serialization fixed point (round-trip stable)", () => {
    const serialized = serializeFrontmatter(
      { type: "Doc", title: "T", tags: ["a", "b"] },
      "# T\n\nBody.\n",
    );
    const parsed = parseFrontmatter(serialized);

    expect(serializeFrontmatter(parsed.data, parsed.body)).toBe(serialized);
  });
});
