import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { OPENWIKI_VERSION } from "../src/version.ts";

const packageJsonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json",
);

const declaredVersion = (
  JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string }
).version;

describe("OPENWIKI_VERSION", () => {
  it("matches the version declared in package.json", () => {
    expect(OPENWIKI_VERSION).toBe(declaredVersion);
  });

  it("never falls back to the unknown sentinel in this repo", () => {
    // The reader returns "0.0.0-unknown" only when no openwiki package.json can
    // be found. Running from source, it must always locate the real manifest.
    expect(OPENWIKI_VERSION).not.toBe("0.0.0-unknown");
    expect(OPENWIKI_VERSION).toMatch(/^\d+\.\d+\.\d+/u);
  });
});
