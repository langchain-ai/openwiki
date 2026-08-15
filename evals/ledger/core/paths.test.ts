import path from "node:path";

import { describe, expect, test } from "vitest";

import { isContainedBy, OPEN_WIKI_DIR, wikiDirFor } from "./paths.js";

describe("constants", () => {
  test("mirror OpenWiki's on-disk contract", () => {
    expect(OPEN_WIKI_DIR).toBe("openwiki");
  });
});

describe("wikiDirFor", () => {
  test("joins the openwiki directory onto the worktree", () => {
    expect(wikiDirFor("/tmp/wt")).toBe(path.join("/tmp/wt", OPEN_WIKI_DIR));
  });

  test("normalizes a trailing separator on the worktree path", () => {
    expect(wikiDirFor("/tmp/wt/")).toBe(path.join("/tmp/wt", OPEN_WIKI_DIR));
  });
});

describe("isContainedBy", () => {
  const root = "/tmp/ledger-workspace";

  test("treats a path as containing itself", () => {
    expect(isContainedBy(root, root)).toBe(true);
  });

  test("accepts a directly nested child", () => {
    expect(isContainedBy(root, "/tmp/ledger-workspace/wt")).toBe(true);
  });

  test("accepts a deeply nested descendant", () => {
    expect(isContainedBy(root, "/tmp/ledger-workspace/wt/openwiki/a/b")).toBe(
      true,
    );
  });

  test("accepts a child reached via .. that resolves back inside the root", () => {
    expect(isContainedBy(root, "/tmp/ledger-workspace/wt/../openwiki")).toBe(
      true,
    );
  });

  test("rejects the immediate parent directory", () => {
    expect(isContainedBy(root, "/tmp")).toBe(false);
  });

  test("rejects the filesystem root", () => {
    expect(isContainedBy(root, "/")).toBe(false);
  });

  test("rejects an unrelated path elsewhere on the tree", () => {
    expect(isContainedBy(root, "/var/lib/other")).toBe(false);
  });

  test("rejects a sibling that merely shares a string prefix", () => {
    // The classic prefix-check bug: these siblings start with the root string
    // but live beside it, not inside it. A raw `startsWith(root)` guard would
    // wrongly accept them and let a destructive op escape.
    expect(isContainedBy(root, "/tmp/ledger-workspace-evil")).toBe(false);
    expect(isContainedBy("/tmp/ledger", "/tmp/ledger-other")).toBe(false);
  });

  test("rejects a child that climbs out of the root via ..", () => {
    expect(isContainedBy(root, "/tmp/ledger-workspace/../ledger-other")).toBe(
      false,
    );
  });

  test("rejects .. resolving to the parent even when spelled as a child", () => {
    // "/tmp/ledger-workspace/.." normalizes to "/tmp", the parent, so it must be
    // rejected despite being written as a path underneath the root.
    expect(isContainedBy(root, "/tmp/ledger-workspace/..")).toBe(false);
  });

  test("accepts a real child whose name merely begins with .. (regression)", () => {
    // path.relative(root, "/tmp/ledger-workspace/..cache") === "..cache". A naive
    // `relative.startsWith("..")` check treats that segment as an escape and
    // rejects a legitimate child. The guard must be segment-aware: "..cache" is
    // inside, only a whole ".." segment climbs out.
    expect(isContainedBy(root, "/tmp/ledger-workspace/..cache")).toBe(true);
    expect(isContainedBy(root, "/tmp/ledger-workspace/wt/..config/x")).toBe(
      true,
    );
  });
});
