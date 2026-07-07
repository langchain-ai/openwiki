import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  decodeUtf8Text,
  sliceLines,
  TextSniffingLocalShellBackend,
} from "../src/agent/text-sniffing-backend.ts";

describe("decodeUtf8Text", () => {
  test("decodes plain UTF-8 text", () => {
    const bytes = new TextEncoder().encode('region = "us-east-1"\n');

    expect(decodeUtf8Text(bytes)).toBe('region = "us-east-1"\n');
  });

  test("decodes multi-byte UTF-8 (accents, CJK, emoji)", () => {
    const bytes = new TextEncoder().encode("café 東京 ✅\n");

    expect(decodeUtf8Text(bytes)).toBe("café 東京 ✅\n");
  });

  test("rejects content containing NUL bytes", () => {
    expect(decodeUtf8Text(new Uint8Array([0x68, 0x69, 0x00, 0x68]))).toBeNull();
  });

  test("rejects invalid UTF-8 sequences", () => {
    // 0xff is never valid in UTF-8.
    expect(decodeUtf8Text(new Uint8Array([0xff, 0xfe, 0x00, 0x01]))).toBeNull();
  });
});

describe("sliceLines", () => {
  const text = ["l1", "l2", "l3", "l4"].join("\n");

  test("applies 0-indexed offset and line limit", () => {
    expect(sliceLines(text, 1, 2)).toBe("l2\nl3");
  });

  test("returns empty string for limit 0", () => {
    expect(sliceLines(text, 0, 0)).toBe("");
  });

  test("returns everything within a large limit", () => {
    expect(sliceLines(text, 0, 500)).toBe(text);
  });
});

describe("TextSniffingLocalShellBackend", () => {
  let rootDir: string;
  let backend: TextSniffingLocalShellBackend;

  beforeAll(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-sniff-"));
    await writeFile(
      path.join(rootDir, "terraform.tfvars"),
      'region = "us-east-1"\ninstance_type = "t3.micro"\n',
    );
    await writeFile(
      path.join(rootDir, "notes.txt"),
      "first line\nsecond line\n",
    );
    // PNG magic bytes followed by NULs: genuinely binary.
    await writeFile(
      path.join(rootDir, "image.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    );
    backend = new TextSniffingLocalShellBackend({
      rootDir,
      timeout: 30,
      virtualMode: true,
    });
    await backend.initialize();
  });

  afterAll(async () => {
    await backend.close();
    await rm(rootDir, { force: true, recursive: true });
  });

  test("returns tfvars content as text despite the unmapped extension", async () => {
    const result = await backend.read("/terraform.tfvars");

    expect(result.error).toBeUndefined();
    expect(result.mimeType).toBe("text/plain");
    expect(result.content).toContain('region = "us-east-1"');
  });

  test("applies offset/limit line semantics to sniffed text", async () => {
    const result = await backend.read("/terraform.tfvars", 1, 1);

    expect(result.content).toBe('instance_type = "t3.micro"');
  });

  test("keeps the base class's text path for known text extensions", async () => {
    const result = await backend.read("/notes.txt");

    expect(result.error).toBeUndefined();
    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("first line");
  });

  test("still returns genuinely binary files as binary", async () => {
    const result = await backend.read("/image.png");

    expect(result.error).toBeUndefined();
    expect(typeof result.content).not.toBe("string");
  });
});
