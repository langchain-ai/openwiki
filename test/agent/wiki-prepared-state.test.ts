import { describe, expect, test } from "vitest";
import {
  deserializePreparedWikiState,
  serializePreparedWikiState,
  type PersistedPreparedWikiState,
  type PreparedWikiState,
} from "../../src/agent/wiki-finalizer.ts";

describe("persisted prepared wiki state", () => {
  test("serializes provenance deterministically into JSON-safe data", () => {
    const prepared: PreparedWikiState = {
      generatedProvenance: new Map([
        [
          "/openwiki/z-last.md",
          {
            bodyHash: "z-body",
            generated: { by: "openwiki/0.3.3" },
          },
        ],
        [
          "/openwiki/a-first.md",
          {
            bodyHash: "a-body",
            generated: {
              by: "host-agent/codex",
              at: "2026-08-23T12:00:00.000Z",
            },
          },
        ],
      ]),
    };

    const persisted = serializePreparedWikiState(prepared);

    expect(persisted).toEqual({
      generatedProvenance: [
        {
          page: "/openwiki/a-first.md",
          bodyHash: "a-body",
          generated: {
            by: "host-agent/codex",
            at: "2026-08-23T12:00:00.000Z",
          },
        },
        {
          page: "/openwiki/z-last.md",
          bodyHash: "z-body",
          generated: { by: "openwiki/0.3.3" },
        },
      ],
    });
    const parsed: unknown = JSON.parse(JSON.stringify(persisted));
    expect(parsed).toEqual(persisted);

    persisted.generatedProvenance[0].generated!.by = "changed";
    expect(
      prepared.generatedProvenance.get("/openwiki/a-first.md")?.generated?.by,
    ).toBe("host-agent/codex");
  });

  test("recreates the exact finalization baseline after a JSON round trip", () => {
    const prepared: PreparedWikiState = {
      generatedProvenance: new Map([
        [
          "/openwiki/page.md",
          {
            bodyHash: "page-body",
            generated: {
              by: "openwiki/0.3.3",
              at: "2026-08-23T12:00:00.000Z",
            },
          },
        ],
      ]),
    };
    const parsed: unknown = JSON.parse(
      JSON.stringify(serializePreparedWikiState(prepared)),
    );

    const restored = deserializePreparedWikiState(
      parsed as PersistedPreparedWikiState,
    );

    expect(restored.generatedProvenance).toEqual(prepared.generatedProvenance);
    expect(restored.generatedProvenance).not.toBe(prepared.generatedProvenance);
  });
});
