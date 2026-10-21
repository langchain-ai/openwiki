import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadRawRecords } from "../../src/wiki/theme-extraction.ts";

// This loader chain must not need connector-specific code to recognize a new
// raw-pull shape. `.jsonl` and per-file markdown are already handled; this
// covers a REST client that serializes one whole response array to a plain
// `.json` file, including a `{data: [...]}`-style wrapper object.

describe("loadRawRecords JSON file fallback", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("a bare JSON array file is read as records", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "openwiki-json-"));
    await writeFile(
      path.join(dir, "records.json"),
      JSON.stringify([
        { id: "1", category: "auth" },
        { id: "2", category: "auth" },
        { id: "3", category: "auth" },
      ]),
    );

    const records = await loadRawRecords(dir);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.categoricalFields.get("category"))).toEqual(["auth", "auth", "auth"]);
  });

  test("a wrapper object ({data: [...]}) is unwrapped automatically", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "openwiki-json-"));
    await writeFile(
      path.join(dir, "response.json"),
      JSON.stringify({ meta: { page: 1 }, data: [{ id: "1", type: "bug" }, { id: "2", type: "bug" }] }),
    );

    const records = await loadRawRecords(dir);
    expect(records).toHaveLength(2);
  });

  test("manifest.json is never treated as a record source", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "openwiki-json-"));
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify([{ id: "should-not-count" }]));

    const records = await loadRawRecords(dir);
    expect(records).toHaveLength(0);
  });

  test(".jsonl still wins over a .json file in the same directory", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "openwiki-json-"));
    await writeFile(path.join(dir, "issues.jsonl"), `${JSON.stringify({ id: "jsonl-1" })}\n`);
    await writeFile(path.join(dir, "extra.json"), JSON.stringify([{ id: "json-1" }]));

    const records = await loadRawRecords(dir);
    expect(records.map((r) => r.id)).toEqual(["jsonl-1"]);
  });

  test("a JSON file with no array anywhere in it yields no records", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "openwiki-json-"));
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ setting: "value", nested: { a: 1 } }));

    const records = await loadRawRecords(dir);
    expect(records).toHaveLength(0);
  });
});
