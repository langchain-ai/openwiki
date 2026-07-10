import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseFrontmatter } from "../../src/agent/okf/frontmatter.ts";
import {
  createConceptBodyHashes,
  normalizeOkfBundle,
} from "../../src/agent/okf/normalize.ts";
import { createOpenWikiContentSnapshot } from "../../src/agent/utils.ts";

const DAY1_MORNING = new Date("2026-07-10T09:00:00.000Z");
const DAY1_AFTERNOON = new Date("2026-07-10T15:00:00.000Z");

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "okf-update-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function bundleRoot(): string {
  return path.join(cwd, "openwiki");
}

async function writeWiki(relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(bundleRoot(), relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function readWiki(relativePath: string): Promise<string> {
  return readFile(path.join(bundleRoot(), relativePath), "utf8");
}

async function appendToBody(relativePath: string, text: string): Promise<void> {
  const current = await readWiki(relativePath);
  await writeFile(
    path.join(bundleRoot(), relativePath),
    current + text,
    "utf8",
  );
}

async function normalize(command: "init" | "update", now: Date): Promise<void> {
  const beforeBodyHashes = await createConceptBodyHashes(cwd, "repository");
  await normalizeOkfBundle({
    cwd,
    outputMode: "repository",
    command,
    model: "test-model",
    beforeBodyHashes,
    now,
  });
}

async function readTree(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(current: string, rel: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, next);
      } else {
        files[next] = await readFile(abs, "utf8");
      }
    }
  }
  await walk(dir, "");
  return files;
}

describe("update safety", () => {
  test("running twice on an unchanged tree is byte-identical (no timestamp/log churn)", async () => {
    await writeWiki("quickstart.md", "# Home\n\nEntry point.\n");
    await writeWiki(
      "domain/orders.md",
      "---\ntype: Domain Concept\ntitle: Orders\ndescription: Lifecycle.\n---\n# Orders\n\nStates.\n",
    );

    await normalize("init", DAY1_MORNING);
    const first = await readTree(bundleRoot());

    // A later clock must not matter: nothing changed, so nothing is rewritten.
    await normalize("update", DAY1_AFTERNOON);
    const second = await readTree(bundleRoot());

    expect(second).toEqual(first);
    expect(parseFrontmatter(second["domain/orders.md"]).data.timestamp).toBe(
      DAY1_MORNING.toISOString(),
    );
    // Only the init entry exists; the no-op update added nothing.
    expect(second["log.md"].match(/^- /gmu)?.length).toBe(1);
  });

  test("only the concept whose body changed gets a new timestamp", async () => {
    await writeWiki("quickstart.md", "# Home\n\nEntry point.\n");
    await writeWiki("domain/orders.md", "# Orders\n\nOld body.\n");
    await normalize("init", DAY1_MORNING);

    // Capture body hashes as index.ts does: before the edit.
    const before = await createConceptBodyHashes(cwd, "repository");
    await appendToBody("domain/orders.md", "\nNew line.\n");
    await normalizeOkfBundle({
      cwd,
      outputMode: "repository",
      command: "update",
      model: "test-model",
      beforeBodyHashes: before,
      now: DAY1_AFTERNOON,
    });

    expect(
      parseFrontmatter(await readWiki("domain/orders.md")).data.timestamp,
    ).toBe(DAY1_AFTERNOON.toISOString());
    expect(
      parseFrontmatter(await readWiki("quickstart.md")).data.timestamp,
    ).toBe(DAY1_MORNING.toISOString());
  });

  test("producer-added frontmatter keys survive a re-run", async () => {
    await writeWiki(
      "domain/orders.md",
      "---\ntype: Domain Concept\ntitle: Orders\ndescription: Lifecycle.\nowner: platform\n---\n# Orders\n\nStates.\n",
    );

    await normalize("init", DAY1_MORNING);
    await normalize("update", DAY1_AFTERNOON);

    expect(
      parseFrontmatter(await readWiki("domain/orders.md")).data.owner,
    ).toBe("platform");
  });

  test("a no-op update leaves the content snapshot stable", async () => {
    await writeWiki("quickstart.md", "# Home\n\nEntry point.\n");
    await normalize("init", DAY1_MORNING);

    const before = await createOpenWikiContentSnapshot(cwd, "repository");
    await normalize("update", DAY1_AFTERNOON);
    const after = await createOpenWikiContentSnapshot(cwd, "repository");

    expect(after).toBe(before);
  });

  test("log.md is ISO-dated, append-only, and grouped by date", async () => {
    await writeWiki("quickstart.md", "# Home\n\nEntry point.\n");
    await normalize("init", DAY1_MORNING);

    const before = await createConceptBodyHashes(cwd, "repository");
    await appendToBody("quickstart.md", "\nEdited.\n");
    await normalizeOkfBundle({
      cwd,
      outputMode: "repository",
      command: "update",
      model: "test-model",
      beforeBodyHashes: before,
      now: DAY1_AFTERNOON,
    });

    const log = await readWiki("log.md");
    expect(log.startsWith("# Log")).toBe(true);
    // Same-day runs group under one ISO date heading, newest appended after.
    expect(log.match(/^## \d{4}-\d{2}-\d{2}$/gmu)).toEqual(["## 2026-07-10"]);
    const entries = log.match(/^- \*\*(init|update)\*\*/gmu);
    expect(entries).toEqual(["- **init**", "- **update**"]);
  });
});
