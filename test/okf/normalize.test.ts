import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseFrontmatter } from "../../src/agent/okf/frontmatter.ts";
import { normalizeOkfBundle } from "../../src/agent/okf/normalize.ts";

const FIXED_NOW = new Date("2026-07-10T12:00:00.000Z");

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "okf-normalize-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function writeWiki(relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(cwd, "openwiki", relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function readWiki(relativePath: string): Promise<string> {
  return readFile(path.join(cwd, "openwiki", relativePath), "utf8");
}

async function normalize(): Promise<void> {
  await normalizeOkfBundle({
    cwd,
    outputMode: "repository",
    command: "init",
    model: "test-model",
    beforeBodyHashes: new Map(),
    now: FIXED_NOW,
  });
}

describe("normalizeOkfBundle (repository)", () => {
  test("stamps type/title/description and generates the root index", async () => {
    await writeWiki(
      "quickstart.md",
      "# Orders Service\n\nA small API for orders. It does more.\n",
    );
    await writeWiki(
      "architecture/overview.md",
      "---\ntitle: Architecture overview\n---\n# Architecture overview\n\nHow it fits.\n",
    );

    await normalize();

    const quickstart = parseFrontmatter(await readWiki("quickstart.md"));
    expect(quickstart.data.type).toBe("Repository Overview");
    expect(quickstart.data.title).toBe("Orders Service");
    expect(quickstart.data.description).toBe("A small API for orders.");
    expect(quickstart.data.timestamp).toBe(FIXED_NOW.toISOString());

    const overview = parseFrontmatter(
      await readWiki("architecture/overview.md"),
    );
    expect(overview.data.type).toBe("Architecture");
    expect(overview.data.title).toBe("Architecture overview");

    expect(await readWiki("index.md")).toContain('okf_version: "0.1"');
  });

  test("strips okf_version from concept frontmatter", async () => {
    await writeWiki(
      "domain/orders.md",
      '---\ntype: Domain Concept\nokf_version: "0.1"\n---\n# Orders\n\nLifecycle.\n',
    );

    await normalize();

    const orders = parseFrontmatter(await readWiki("domain/orders.md"));
    expect(orders.data.type).toBe("Domain Concept");
    expect(orders.data.okf_version).toBeUndefined();
  });

  test("derives description from the first sentence, skipping the heading", async () => {
    await writeWiki(
      "domain/orders.md",
      "# Orders\n\nAn order moves through states. It can be refunded.\n",
    );

    await normalize();

    expect(
      parseFrontmatter(await readWiki("domain/orders.md")).data.description,
    ).toBe("An order moves through states.");
  });
});
