import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, test } from "vitest";

// The build's asset copy is a guard: `tsc` does not emit styles.css, so if this
// step silently no-ops the served and exported stylesheet vanishes while every
// other check stays green (the visualizer tests all inject assets through a
// seam and never read dist). Exercise the real .cjs the build runs, against
// temp directories, so the repo's own dist is never touched.
const require = createRequire(import.meta.url);
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "copy-visualize-assets.cjs",
);
const { ASSETS, copyAsset } = require(SCRIPT) as {
  ASSETS: { source: string; destination: string }[];
  copyAsset: (asset: { source: string; destination: string }) => void;
};

let dir: string;
let source: string;
let destination: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openwiki-copy-assets-"));
  source = path.join(dir, "styles.css");
  destination = path.join(dir, "dist", "styles.css");
  await writeFile(source, ":root { --bg: #000; }\n", "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("copies the asset verbatim into an existing destination directory", async () => {
  await mkdir(path.dirname(destination), { recursive: true });

  copyAsset({ source, destination });

  expect(await readFile(destination, "utf8")).toBe(":root { --bg: #000; }\n");
});

test("fails when the source asset is missing", async () => {
  await rm(source);

  expect(() => copyAsset({ source, destination })).toThrow(
    /source asset is missing/,
  );
});

test("fails with a build hint when the destination directory does not exist", () => {
  // The directory is absent because nothing built dist/ first; the raw ENOENT
  // from copyFileSync would not say that.
  expect(() => copyAsset({ source, destination })).toThrow(
    /destination directory does not exist \(run the build first\)/,
  );
});

test("fails when the copied asset lands empty", async () => {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(source, "", "utf8");

  expect(() => copyAsset({ source, destination })).toThrow(
    /destination asset is missing or empty/,
  );
});

test("declares the visualizer stylesheet, copied from src into dist", () => {
  expect(ASSETS).toHaveLength(1);
  const [stylesheet] = ASSETS;
  expect(stylesheet.source).toMatch(/src[\\/]visualize[\\/]styles\.css$/);
  expect(stylesheet.destination).toMatch(/dist[\\/]visualize[\\/]styles\.css$/);
});
