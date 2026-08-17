import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { ObsoleteFactTarget, SurfaceItem } from "../core/types.js";
import {
  createTinyRepo,
  type TinyCommit,
  type TinyRepo,
} from "../testing/tiny-repo.js";
import {
  advanceObsoleteWatchSet,
  diffSurface,
  extractSurface,
  obsoleteTargetsFor,
} from "./surface.js";

/**
 * A calc-shaped history that mirrors the real calc benchmark: T0 ships `add` and
 * `negate` at 1.0.0, T1 introduces `subtract`, and T2 removes `negate` and bumps
 * to 2.0.0. Built once for the whole suite because git commits are the slow part.
 */
const CALC_HISTORY: TinyCommit[] = [
  {
    message: "calc 1.0.0 with add and negate",
    files: {
      "src/calc.ts": [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
        "export function negate(x: number): number {",
        "  return -x;",
        "}",
        "",
      ].join("\n"),
      "src/version.ts": 'export const VERSION = "1.0.0";\n',
      "README.md": "# calc\n",
    },
  },
  {
    message: "introduce subtract",
    files: {
      "src/calc.ts": [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
        "export function negate(x: number): number {",
        "  return -x;",
        "}",
        "",
        "export function subtract(a: number, b: number): number {",
        "  return a - b;",
        "}",
        "",
      ].join("\n"),
    },
  },
  {
    message: "remove negate, bump to 2.0.0",
    files: {
      "src/calc.ts": [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
        "export function subtract(a: number, b: number): number {",
        "  return a - b;",
        "}",
        "",
      ].join("\n"),
      "src/version.ts": 'export const VERSION = "2.0.0";\n',
    },
  },
];

/**
 * Index a surface by `factId` for concise per-item assertions.
 *
 * @param surface - The surface items to index.
 *
 * @returns The items keyed by `factId`.
 */
function byId(surface: SurfaceItem[]): Map<string, SurfaceItem> {
  return new Map(surface.map((item) => [item.factId, item]));
}

describe("surface", () => {
  let repo: TinyRepo;
  let t0: SurfaceItem[];
  let t1: SurfaceItem[];
  let t2: SurfaceItem[];

  beforeAll(async () => {
    repo = await createTinyRepo(CALC_HISTORY);
    t0 = await extractSurface(repo.repoPath, repo.shas[0]);
    t1 = await extractSurface(repo.repoPath, repo.shas[1]);
    t2 = await extractSurface(repo.repoPath, repo.shas[2]);
  });

  afterAll(async () => {
    await repo.dispose();
  });

  describe("extractSurface", () => {
    test("collects exported symbols, source files, and the version", () => {
      const ids = t0.map((item) => item.factId);

      expect(ids).toContain("symbol:add");
      expect(ids).toContain("symbol:negate");
      expect(ids).toContain("file:src/calc.ts");
      expect(ids).toContain("file:src/version.ts");
      expect(ids).toContain("version");
    });

    test("omits the VERSION constant from the symbol set", () => {
      expect(t0.map((item) => item.factId)).not.toContain("symbol:VERSION");
    });

    test("prefers the exported VERSION constant for the version item", () => {
      expect(byId(t0).get("version")?.name).toBe("1.0.0");
      expect(byId(t2).get("version")?.name).toBe("2.0.0");
    });

    test("skips non-source files such as README.md", () => {
      expect(t0.map((item) => item.factId)).not.toContain("file:README.md");
    });

    test("reconstructs a symbol signature", () => {
      expect(byId(t0).get("symbol:add")?.signature).toBe(
        "add(a: number, b: number): number",
      );
    });

    test("is sorted by factId and deterministic across calls", async () => {
      const sorted = [...t0].sort((a, b) => a.factId.localeCompare(b.factId));
      expect(t0.map((item) => item.factId)).toEqual(
        sorted.map((item) => item.factId),
      );

      const again = await extractSurface(repo.repoPath, repo.shas[0]);
      expect(again).toEqual(t0);
    });

    test("gives an unchanged statement a stable factVersionId", () => {
      expect(byId(t0).get("symbol:add")?.factVersionId).toBe(
        byId(t1).get("symbol:add")?.factVersionId,
      );
    });
  });

  describe("diffSurface", () => {
    test("T0 to T1 introduces subtract and leaves the rest stable", () => {
      const transitions = diffSurface(t0, t1, "T0", "T1");

      expect(transitions.introduced.map((item) => item.factId)).toEqual([
        "symbol:subtract",
      ]);
      expect(transitions.removed).toEqual([]);
      expect(transitions.changed).toEqual([]);
      expect(transitions.stable.map((item) => item.factId)).toContain(
        "symbol:add",
      );
    });

    test("T1 to T2 removes negate and changes the version", () => {
      const transitions = diffSurface(t1, t2, "T1", "T2");

      expect(transitions.removed.map((item) => item.factId)).toEqual([
        "symbol:negate",
      ]);
      expect(transitions.changed.map((item) => item.factId)).toContain(
        "version",
      );
      expect(transitions.introduced).toEqual([]);
      expect(transitions.checkpointId).toBe("T2");
      expect(transitions.previousCheckpointId).toBe("T1");
    });
  });

  describe("obsoleteTargetsFor", () => {
    test("targets the previous version of removed and changed items", () => {
      const targets = obsoleteTargetsFor(diffSurface(t1, t2, "T1", "T2"));
      const ids = targets.map((target) => target.factId);

      expect(ids).toContain("symbol:negate");
      expect(ids).toContain("version");

      const version = targets.find((target) => target.factId === "version");
      expect(version?.obsoleteStatement).toContain("1.0.0");
    });
  });

  describe("advanceObsoleteWatchSet", () => {
    test("carries an obsolete target forward while it stays obsolete", () => {
      const newlyObsolete = obsoleteTargetsFor(diffSurface(t1, t2, "T1", "T2"));

      const advanced = advanceObsoleteWatchSet({
        outstanding: [],
        surface: t2,
        newlyObsolete,
      });

      // negate is gone from t2, so its obsolete target survives the sticky retire.
      expect(advanced.map((target) => target.factId)).toContain(
        "symbol:negate",
      );
    });

    test("retires a target when the surface revives that exact knowledge", () => {
      const staleNegate: ObsoleteFactTarget = {
        factId: "symbol:negate",
        factVersionId: byId(t0).get("symbol:negate")!.factVersionId,
        obsoleteStatement: byId(t0).get("symbol:negate")!.statement,
      };

      // Advancing against t0 (where negate still exists with that statement)
      // revives the knowledge, so the sticky watch set drops the target.
      const advanced = advanceObsoleteWatchSet({
        outstanding: [staleNegate],
        surface: t0,
        newlyObsolete: [],
      });

      expect(advanced).toEqual([]);
    });

    test("deduplicates a target repeated across carry-forward", () => {
      const newlyObsolete = obsoleteTargetsFor(diffSurface(t1, t2, "T1", "T2"));

      const advanced = advanceObsoleteWatchSet({
        outstanding: newlyObsolete,
        surface: t2,
        newlyObsolete,
      });

      const versionIds = advanced.map((target) => target.factVersionId);
      expect(new Set(versionIds).size).toBe(versionIds.length);
    });
  });
});
