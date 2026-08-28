import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const failureHarness = vi.hoisted(() => ({ manifestRenames: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async rename(...args: Parameters<typeof actual.rename>) {
      const destination = String(args[1]);
      if (
        failureHarness.manifestRenames > 0 &&
        destination.endsWith("openwiki/.page-manifest.json")
      ) {
        failureHarness.manifestRenames -= 1;
        throw new Error("injected manifest rename failure");
      }
      return actual.rename(...args);
    },
  };
});

import { toRepositoryPagePath } from "../../src/claims/brains/code/paths.ts";
import { ClaimsStore } from "../../src/claims/brains/code/store.ts";
import { RepositoryRunError } from "../../src/generation/errors.ts";
import {
  createEmptyRepositoryPageManifest,
  isRepositoryPageCompletionCurrent,
  readRepositoryPageManifest,
  recordRepositoryPageCompletion,
  replaceRepositoryPageManifest,
  repositoryPageManifestPath,
  seedRepositoryPageManifest,
  writeRepositoryPageManifest,
  type RepositoryPageManifest,
} from "../../src/generation/page-manifest.ts";

const SOURCE_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const OTHER_SOURCE_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const GIT_HEAD = "0123456789abcdef";
const OTHER_GIT_HEAD = "fedcba9876543210";
const VERIFICATION = {
  by: "openwiki/test",
  at: "2026-08-25T00:00:00.000Z",
};

let root: string;

beforeEach(async () => {
  failureHarness.manifestRenames = 0;
  root = await mkdtemp(path.join(tmpdir(), "openwiki-page-manifest-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Writes one factual Markdown page and its synchronized Claims sidecar.
 *
 * @param page - Canonical factual page path.
 * @param markdown - Exact Markdown bytes to persist.
 * @param verified - Whether the sidecar contains durable verification.
 * @returns Hash of the persisted Markdown bytes.
 */
async function writeClaimsPage(
  page: string,
  markdown: string,
  verified = true,
): Promise<string> {
  const file = path.join(root, toRepositoryPagePath(page));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, markdown, "utf8");

  const store = new ClaimsStore(root);
  const pageVersion = await store.hashPage(page);
  await store.writePage(page, {
    schemaVersion: 1,
    pageVersion,
    claims: [],
    ...(verified ? { verification: VERIFICATION } : {}),
  });
  return pageVersion;
}

/**
 * Persists raw manifest JSON for strict reader-validation tests.
 *
 * @param value - JSON-compatible persisted value.
 */
async function writeRawManifest(value: unknown): Promise<void> {
  const file = repositoryPageManifestPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("repository page-manifest persistence", () => {
  test("returns an empty manifest when no committed state exists", async () => {
    await expect(readRepositoryPageManifest(root)).resolves.toEqual(
      createEmptyRepositoryPageManifest(),
    );
  });

  test("fails closed for malformed JSON and schema extensions", async () => {
    const file = repositoryPageManifestPath(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{not-json\n", "utf8");

    await expect(readRepositoryPageManifest(root)).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<RepositoryRunError>);

    await writeRawManifest({
      schemaVersion: 1,
      pages: {},
      unexpected: true,
    });
    await expect(readRepositoryPageManifest(root)).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<RepositoryRunError>);

    await writeRawManifest({
      schemaVersion: 1,
      pages: {
        "/openwiki/page.md": {
          pageVersion: `sha256:${"c".repeat(64)}`,
          unexpected: true,
        },
      },
    });
    await expect(readRepositoryPageManifest(root)).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<RepositoryRunError>);
  });

  test.each([
    ["invalid hash", "/openwiki/page.md", "sha256:not-a-hash"],
    ["non-canonical path", "openwiki/page.md", `sha256:${"c".repeat(64)}`],
    ["structural page", "/openwiki/index.md", `sha256:${"c".repeat(64)}`],
  ])("rejects an %s", async (_label, page, pageVersion) => {
    await writeRawManifest({
      schemaVersion: 1,
      pages: { [page]: { pageVersion } },
    });

    await expect(readRepositoryPageManifest(root)).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<RepositoryRunError>);
  });

  test("writes stable page order without leaving temporary files", async () => {
    const manifest: RepositoryPageManifest = {
      schemaVersion: 1,
      pages: {
        "/openwiki/zulu.md": { pageVersion: `sha256:${"f".repeat(64)}` },
        "/openwiki/alpha.md": { pageVersion: `sha256:${"e".repeat(64)}` },
      },
    };

    await writeRepositoryPageManifest(root, manifest);

    expect(await readFile(repositoryPageManifestPath(root), "utf8")).toBe(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          pages: {
            "/openwiki/alpha.md": manifest.pages["/openwiki/alpha.md"],
            "/openwiki/zulu.md": manifest.pages["/openwiki/zulu.md"],
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(
      (await readdir(path.join(root, "openwiki"))).filter((entry) =>
        entry.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  test("preserves durable state and cleans up when atomic rename fails", async () => {
    const original: RepositoryPageManifest = {
      schemaVersion: 1,
      pages: {
        "/openwiki/original.md": {
          pageVersion: `sha256:${"d".repeat(64)}`,
        },
      },
    };
    await writeRepositoryPageManifest(root, original);
    failureHarness.manifestRenames = 1;

    await expect(
      writeRepositoryPageManifest(root, {
        schemaVersion: 1,
        pages: {
          "/openwiki/replacement.md": {
            pageVersion: `sha256:${"e".repeat(64)}`,
          },
        },
      }),
    ).rejects.toThrow("injected manifest rename failure");

    expect(await readRepositoryPageManifest(root)).toEqual(original);
    expect(
      (await readdir(path.join(root, "openwiki"))).filter((entry) =>
        entry.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });
});

describe("repository page completion", () => {
  test("refuses to advance an unverified or mismatched Claims page", async () => {
    const page = "/openwiki/page.md";
    await writeClaimsPage(page, "# Page\n", false);

    await expect(
      recordRepositoryPageCompletion(root, page, {
        gitHead: GIT_HEAD,
        sourceFingerprint: SOURCE_FINGERPRINT,
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });

    await writeClaimsPage(page, "# Verified\n");
    await writeFile(path.join(root, toRepositoryPagePath(page)), "# Edited\n");

    await expect(
      recordRepositoryPageCompletion(root, page, {
        gitHead: GIT_HEAD,
        sourceFingerprint: SOURCE_FINGERPRINT,
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await expect(readRepositoryPageManifest(root)).resolves.toEqual(
      createEmptyRepositoryPageManifest(),
    );
  });

  test("records verified page bytes and their exact source checkpoint", async () => {
    const page = "/openwiki/page.md";
    const pageVersion = await writeClaimsPage(page, "# Page\n");

    await expect(
      recordRepositoryPageCompletion(root, page, {
        gitHead: GIT_HEAD,
        sourceFingerprint: SOURCE_FINGERPRINT,
      }),
    ).resolves.toEqual({
      gitHead: GIT_HEAD,
      sourceFingerprint: SOURCE_FINGERPRINT,
      pageVersion,
    });
    await expect(readRepositoryPageManifest(root)).resolves.toEqual({
      schemaVersion: 1,
      pages: {
        [page]: {
          gitHead: GIT_HEAD,
          sourceFingerprint: SOURCE_FINGERPRINT,
          pageVersion,
        },
      },
    });
  });

  test("seeds missing verified pages while preserving newer coverage", async () => {
    const existingPage = "/openwiki/existing.md";
    const seededPage = "/openwiki/seeded.md";
    await writeClaimsPage(existingPage, "# Existing\n");
    const seededVersion = await writeClaimsPage(seededPage, "# Seeded\n");
    await recordRepositoryPageCompletion(root, existingPage, {
      gitHead: OTHER_GIT_HEAD,
      sourceFingerprint: OTHER_SOURCE_FINGERPRINT,
    });

    await seedRepositoryPageManifest(
      root,
      [seededPage, existingPage],
      GIT_HEAD,
    );

    const manifest = await readRepositoryPageManifest(root);
    expect(manifest.pages[existingPage]).toMatchObject({
      gitHead: OTHER_GIT_HEAD,
      sourceFingerprint: OTHER_SOURCE_FINGERPRINT,
    });
    expect(manifest.pages[seededPage]).toEqual({
      gitHead: GIT_HEAD,
      pageVersion: seededVersion,
    });
  });

  test("leaves unverifiable legacy pages uncovered during migration", async () => {
    const verifiedPage = "/openwiki/verified.md";
    const unverifiedPage = "/openwiki/unverified.md";
    await writeClaimsPage(verifiedPage, "# Verified\n");
    await writeClaimsPage(unverifiedPage, "# Unverified\n", false);

    await expect(
      seedRepositoryPageManifest(
        root,
        [unverifiedPage, verifiedPage, "/openwiki/missing.md"],
        GIT_HEAD,
      ),
    ).resolves.toBeUndefined();

    const manifest = await readRepositoryPageManifest(root);
    expect(Object.keys(manifest.pages)).toEqual([verifiedPage]);
  });

  test("accepts only exact source and durable page/sidecar matches", async () => {
    const page = "/openwiki/page.md";
    await writeClaimsPage(page, "# Page\n");
    const source = {
      gitHead: GIT_HEAD,
      sourceFingerprint: SOURCE_FINGERPRINT,
    };
    await recordRepositoryPageCompletion(root, page, source, "host/codex");

    await expect(readRepositoryPageManifest(root)).resolves.toMatchObject({
      pages: { [page]: { completedBy: "host/codex" } },
    });

    await expect(
      isRepositoryPageCompletionCurrent(root, page, source),
    ).resolves.toBe(true);
    await expect(
      isRepositoryPageCompletionCurrent(root, page, {
        ...source,
        sourceFingerprint: OTHER_SOURCE_FINGERPRINT,
      }),
    ).resolves.toBe(false);
    await expect(
      isRepositoryPageCompletionCurrent(root, page, {
        ...source,
        gitHead: OTHER_GIT_HEAD,
      }),
    ).resolves.toBe(false);
    await expect(
      isRepositoryPageCompletionCurrent(root, page, { gitHead: GIT_HEAD }),
    ).resolves.toBe(false);

    await writeFile(path.join(root, toRepositoryPagePath(page)), "# Edited\n");
    await expect(
      isRepositoryPageCompletionCurrent(root, page, source),
    ).resolves.toBe(false);
  });

  test("replacement retains only the surviving verified page inventory", async () => {
    const survivingPage = "/openwiki/surviving.md";
    const deletedPage = "/openwiki/deleted.md";
    const survivingVersion = await writeClaimsPage(
      survivingPage,
      "# Surviving\n",
    );
    await writeClaimsPage(deletedPage, "# Deleted\n");
    await recordRepositoryPageCompletion(root, deletedPage, {
      gitHead: GIT_HEAD,
      sourceFingerprint: SOURCE_FINGERPRINT,
    });

    await replaceRepositoryPageManifest(root, [survivingPage], {
      gitHead: OTHER_GIT_HEAD,
      sourceFingerprint: OTHER_SOURCE_FINGERPRINT,
    });

    await expect(readRepositoryPageManifest(root)).resolves.toEqual({
      schemaVersion: 1,
      pages: {
        [survivingPage]: {
          gitHead: OTHER_GIT_HEAD,
          sourceFingerprint: OTHER_SOURCE_FINGERPRINT,
          pageVersion: survivingVersion,
        },
      },
    });
  });
});
