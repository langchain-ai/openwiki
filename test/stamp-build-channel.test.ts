import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

// The release-time channel stamp is exercised end-to-end against a temp copy of
// the constant, so the test proves the real .cjs artifact the release runs — not
// a re-implementation — and never mutates the repo's own gates.ts.
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "stamp-build-channel.cjs",
);

/**
 * A minimal fixture with the exact assignment the stamp targets, wrapped in a
 * docstring and neighboring code so the test also proves the rest of the file is
 * left untouched.
 */
const FIXTURE = [
  "/** Baked at build time; do not edit by hand. */",
  'const BUILD_CHANNEL: BuildChannel = "community";',
  "",
  "export function buildChannel(): BuildChannel {",
  "  return BUILD_CHANNEL;",
  "}",
  "",
].join("\n");

let dir: string;
let target: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openwiki-stamp-"));
  target = path.join(dir, "gates.ts");
  await writeFile(target, FIXTURE, "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Runs the stamp script against the temp target with `channel` as the env value
 * (omitted entirely when undefined), then returns the rewritten file contents.
 */
function stamp(channel: string | undefined): void {
  const env = { ...process.env };
  if (channel === undefined) {
    delete env.OPENWIKI_BUILD_CHANNEL;
  } else {
    env.OPENWIKI_BUILD_CHANNEL = channel;
  }
  execFileSync(process.execPath, [SCRIPT, target], { env, encoding: "utf8" });
}

describe("stamp-build-channel", () => {
  test('bakes "official" when the env asks for it', async () => {
    stamp("official");

    const result = await readFile(target, "utf8");
    expect(result).toContain('const BUILD_CHANNEL: BuildChannel = "official";');
    // The surrounding file is untouched: docstring and the accessor survive.
    expect(result).toContain("do not edit by hand");
    expect(result).toContain("export function buildChannel()");
  });

  test("defaults to community when the env is unset", async () => {
    stamp(undefined);

    const result = await readFile(target, "utf8");
    expect(result).toContain(
      'const BUILD_CHANNEL: BuildChannel = "community";',
    );
  });

  test("an unrecognized channel falls back to community", async () => {
    // Fail-safe: a typo or an injected value can never mint an official build.
    stamp("official-ish");

    const result = await readFile(target, "utf8");
    expect(result).toContain(
      'const BUILD_CHANNEL: BuildChannel = "community";',
    );
    expect(result).not.toContain("official");
  });

  test("a source missing the assignment fails loudly and is left unchanged", async () => {
    await writeFile(target, "const something = 1;\n", "utf8");

    expect(() => stamp("official")).toThrow();

    const result = await readFile(target, "utf8");
    expect(result).toBe("const something = 1;\n");
  });
});
