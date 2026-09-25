import type {
  BackendProtocolV2,
  EditResult,
  LsResult,
  ReadRawResult,
  WriteResult,
} from "deepagents";
import { describe, expect, test, vi } from "vitest";
import {
  migrateWikiToOkf,
  synchronizeWikiIndexes,
} from "../../src/okf/index-sync.ts";

/**
 * Builds a minimal stub backend so the read/list/write failure branches, which
 * the real disk-backed backend does not surface deterministically, can be
 * driven directly.
 */
function stubBackend(handlers: {
  ls?: (p: string) => LsResult;
  readRaw?: (p: string) => ReadRawResult;
  edit?: (p: string) => EditResult;
  write?: (p: string) => WriteResult;
}): BackendProtocolV2 {
  return {
    ls: vi.fn(handlers.ls ?? (() => ({ files: [] }))),
    readRaw: vi.fn(handlers.readRaw ?? (() => ({ data: undefined }))),
    edit: vi.fn(handlers.edit ?? (() => ({}))),
    write: vi.fn(handlers.write ?? (() => ({}))),
  } as unknown as BackendProtocolV2;
}

function textData(content: string | string[] | Uint8Array): ReadRawResult {
  return {
    data: {
      content,
      mimeType: "text/markdown",
      created_at: "2026-07-13T00:00:00.000Z",
      modified_at: "2026-07-13T00:00:00.000Z",
    },
  };
}

const rootListing: LsResult = {
  files: [{ path: "/openwiki/page.md", is_dir: false }],
};

describe("collectDirectories error propagation", () => {
  test("rethrows when a non-root subdirectory cannot be listed", async () => {
    // The root list is allowed to be missing, but a subdirectory that fails to
    // list is a real error and must abort the sync.
    const backend = stubBackend({
      ls: (p) =>
        p === "/openwiki"
          ? { files: [{ path: "/openwiki/sub/", is_dir: true }] }
          : { error: "listing denied" },
    });

    await expect(synchronizeWikiIndexes(backend, "repository")).rejects.toThrow(
      /Unable to list \/openwiki\/sub/u,
    );
  });
});

describe("readText error handling", () => {
  test("throws an actionable error when a concept file cannot be read", async () => {
    const backend = stubBackend({
      ls: () => rootListing,
      readRaw: () => ({ error: "read denied" }),
    });

    await expect(migrateWikiToOkf(backend, "repository")).rejects.toThrow(
      /Unable to read \/openwiki\/page\.md/u,
    );
  });

  test("rejects a non-text concept file rather than mangling it", async () => {
    const backend = stubBackend({
      ls: () => rootListing,
      readRaw: () => textData(new Uint8Array([1, 2, 3])),
    });

    await expect(migrateWikiToOkf(backend, "repository")).rejects.toThrow(
      /is not a text file/u,
    );
  });
});

describe("write error handling", () => {
  test("surfaces a normalization write failure", async () => {
    // A legacy page (no `type`) must be rewritten with a derived block; if that
    // edit fails the migration fails loudly.
    const backend = stubBackend({
      ls: () => rootListing,
      readRaw: () => textData("# Legacy\n\nBody.\n"),
      edit: () => ({ error: "edit denied" }),
    });

    await expect(migrateWikiToOkf(backend, "repository")).rejects.toThrow(
      /Unable to normalize \/openwiki\/page\.md/u,
    );
  });

  test("surfaces an index write failure", async () => {
    // A conformant page needs no rewrite, so the sync proceeds to write the
    // directory index; a failed index write aborts the run.
    const backend = stubBackend({
      ls: () => rootListing,
      readRaw: () => textData("---\ntype: Reference\ntitle: Page\n---\n"),
      write: () => ({ error: "index write denied" }),
    });

    await expect(synchronizeWikiIndexes(backend, "repository")).rejects.toThrow(
      /Unable to write \/openwiki\/index\.md/u,
    );
  });
});
