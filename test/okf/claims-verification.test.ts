import { describe, expect, test } from "vitest";
import {
  rollbackClaimsVerification,
  synchronizeClaimsVerification,
  type ClaimsVerificationPageStore,
} from "../../src/okf/claims-verification.ts";
import { parseFrontmatterFields } from "../../src/okf/frontmatter.ts";

class MemoryPageStore implements ClaimsVerificationPageStore {
  constructor(readonly pages: Map<string, string>) {}

  discoverPages(): Promise<string[]> {
    return Promise.resolve([...this.pages.keys()].sort());
  }

  readMarkdown(page: string): Promise<string> {
    const content = this.pages.get(page);
    if (content === undefined) throw new Error(`missing ${page}`);
    return Promise.resolve(content);
  }

  writeMarkdown(page: string, content: string): Promise<void> {
    this.pages.set(page, content);
    return Promise.resolve();
  }
}

describe("synchronizeClaimsVerification", () => {
  test("replaces only OpenWiki events and preserves other verifiers", async () => {
    const page = "/openwiki/page.md";
    const original =
      "---\ntype: Reference\nverified:\n  - by: human:reviewer\n    at: 2026-08-19T00:00:00.000Z\n  - by: openwiki/0.3.2\n    at: 2026-08-19T01:00:00.000Z\n  - by: process:security\ncustom: keep\n---\n\n# Page\n";
    const store = new MemoryPageStore(new Map([[page, original]]));

    const changes = await synchronizeClaimsVerification(
      store,
      new Map([
        [
          page,
          {
            by: "openwiki/0.3.3",
            at: "2026-08-20T12:00:00.000Z",
          },
        ],
      ]),
    );

    expect(changes.get(page)).toBe(original);
    expect(parseFrontmatterFields(store.pages.get(page)!)?.verified).toEqual([
      { by: "human:reviewer", at: "2026-08-19T00:00:00.000Z" },
      { by: "process:security" },
      { by: "openwiki/0.3.3", at: "2026-08-20T12:00:00.000Z" },
    ]);
    expect(store.pages.get(page)).toContain("custom: keep");
  });

  test("removes unjustified OpenWiki events and normalizes bare human events", async () => {
    const machine = "/openwiki/machine.md";
    const human = "/openwiki/human.md";
    const store = new MemoryPageStore(
      new Map([
        [
          machine,
          "---\ntype: Reference\nverified: {by: openwiki/0.3.3, at: old}\n---\n# Machine\n",
        ],
        [
          human,
          "---\ntype: Reference\nverified: {by: human:reviewer}\n---\n# Human\n",
        ],
      ]),
    );

    await synchronizeClaimsVerification(store, new Map());

    expect(
      parseFrontmatterFields(store.pages.get(machine)!)?.verified,
    ).toBeUndefined();
    expect(parseFrontmatterFields(store.pages.get(human)!)?.verified).toEqual([
      { by: "human:reviewer" },
    ]);
  });

  test("can restore exact bytes after a later persistence failure", async () => {
    const page = "/openwiki/page.md";
    const original = "---\ntype: Reference\n---\n\n# Page\n";
    const store = new MemoryPageStore(new Map([[page, original]]));
    const changes = await synchronizeClaimsVerification(
      store,
      new Map([
        [page, { by: "openwiki/0.3.3", at: "2026-08-20T12:00:00.000Z" }],
      ]),
    );

    await rollbackClaimsVerification(store, changes, [page]);

    expect(store.pages.get(page)).toBe(original);
  });
});
