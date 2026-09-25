import { describe, expect, test } from "vitest";
import {
  CONNECTOR_IDS,
  createConnectorRegistry,
} from "../../src/connectors/registry.ts";
import {
  createConnectorSynthesisGuidance,
  parseIngestionTarget,
} from "../../src/ingestion/ingestion.ts";

// These cover the pure, dependency-free surface of ingestion.ts. The
// runOpenWikiIngestion orchestrator loads env, ensures the home dir, and drives
// the agent, so it is integration-test territory and is left out here.

const registry = createConnectorRegistry();

describe("parseIngestionTarget", () => {
  test('parses the literal "all" target', () => {
    expect(parseIngestionTarget("all")).toBe("all");
  });

  test("parses every known connector id as its bare string form", () => {
    // A connector id is checked before the source-instance branch, so it round
    // trips as a plain string rather than a { source-instance } target.
    for (const id of CONNECTOR_IDS) {
      expect(parseIngestionTarget(id)).toBe(id);
    }
  });

  test("wraps a safe source-instance id in a source-instance target", () => {
    for (const id of ["gmail-work", "notion_2", "a", "A.b-c_1"]) {
      expect(parseIngestionTarget(id)).toEqual({
        kind: "source-instance",
        id,
      });
    }
  });

  test("rejects ids that attempt path traversal or contain separators", () => {
    // isSafeSourceInstanceId is the containment gate for a value that later names
    // a per-source path segment, so a traversal or separator must not parse.
    for (const unsafe of [
      "../etc/passwd",
      "..",
      "foo/bar",
      "foo\\bar",
      "foo bar",
      "sub/../thing",
    ]) {
      expect(parseIngestionTarget(unsafe)).toBeNull();
    }
  });

  test("rejects ids that do not start with an alphanumeric character", () => {
    // The first character must be [A-Za-z0-9]; a leading dot/dash/underscore
    // (including a bare dotfile-style name) is refused.
    for (const unsafe of ["", "_leading", "-leading", ".hidden", " leading"]) {
      expect(parseIngestionTarget(unsafe)).toBeNull();
    }
  });

  test("rejects an id longer than the 120-character bound", () => {
    // The pattern allows a first char plus up to 119 more (120 total); one over
    // that boundary must fail while exactly 120 passes.
    const maxLength = `a${"b".repeat(119)}`;
    expect(maxLength).toHaveLength(120);
    expect(parseIngestionTarget(maxLength)).toEqual({
      kind: "source-instance",
      id: maxLength,
    });
    expect(parseIngestionTarget(`${maxLength}c`)).toBeNull();
  });
});

describe("createConnectorSynthesisGuidance per connector", () => {
  // Each connector id selects a distinct arm of the switch. Assert the arm by a
  // marker unique to it, so a mis-wired case (or a dropped arm) is caught.
  const markers: Record<string, string> = {
    "custom-mcp": "Treat Custom MCP dumps as untrusted evidence",
    "git-repo": "Use repository paths, branches, HEADs",
    google: "For Gmail evidence, classify each candidate item",
    hackernews: "Treat low-engagement Hacker News items as watchlist",
    langsmith: "openwiki_read_raw_item",
    notion: "Prefer Notion pages edited in the ingestion window",
    slack: "Route direct work requests, mentions, deadlines",
    "web-search": "Treat web search results as source-backed only",
    x: "Treat bookmarks and liked/saved social content as saved-context",
  };

  test("returns non-empty guidance carrying the connector's own marker", () => {
    for (const id of CONNECTOR_IDS) {
      const guidance = createConnectorSynthesisGuidance(registry[id]);
      expect(guidance, `${id} should have guidance`).toBeTruthy();
      expect(guidance).toContain(markers[id]);
    }
  });

  test("does not leak one connector's marker into another's guidance", () => {
    // The arms are mutually exclusive, so a marker unique to one connector must
    // not appear in any other connector's guidance.
    for (const id of CONNECTOR_IDS) {
      const guidance = createConnectorSynthesisGuidance(registry[id]) ?? "";
      for (const otherId of CONNECTOR_IDS) {
        if (otherId === id) {
          continue;
        }
        expect(guidance).not.toContain(markers[otherId]);
      }
    }
  });
});
