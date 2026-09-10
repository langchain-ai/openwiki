import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repositoryRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const minimumNodeVersion = "22.22.0";

describe("Node.js runtime requirement", () => {
  test("matches package metadata and user-facing setup docs", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    ) as { engines?: { node?: string } };
    const readme = readFileSync(path.join(repositoryRoot, "README.md"), "utf8");
    const developmentGuide = readFileSync(
      path.join(repositoryRoot, "DEVELOPMENT.md"),
      "utf8",
    );

    expect(packageJson.engines?.node).toBe(`>=${minimumNodeVersion}`);
    expect(readme).toContain(`Node.js ${minimumNodeVersion} or newer`);
    expect(developmentGuide).toContain(
      `Node.js ${minimumNodeVersion} or newer`,
    );
  });
});
