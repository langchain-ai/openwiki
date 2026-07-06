import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDocumentationBackend,
  toTextOnlyReadResult,
} from "../src/agent/backend.ts";

// A 1x1 transparent PNG. deepagents maps `.png` to `image/png` and returns its
// raw bytes; without the fix this becomes an image/file block that OpenAI's
// Chat Completions API rejects.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("toTextOnlyReadResult", () => {
  test("passes string content through unchanged (deepagents already treats it as text)", () => {
    const original = { content: "# Title\nbody\n", mimeType: "text/markdown" };
    expect(toTextOnlyReadResult("/README.md", original)).toBe(original);
  });

  test("passes error results through unchanged", () => {
    const original = { error: "File '/missing' not found" };
    expect(toTextOnlyReadResult("/missing", original)).toBe(original);
  });

  test("decodes UTF-8 bytes to real text instead of discarding them", () => {
    // Extension-less files (LICENSE, Dockerfile) arrive as octet-stream bytes,
    // but their content is plain text and must be preserved.
    const result = toTextOnlyReadResult("/Dockerfile", {
      content: new TextEncoder().encode("FROM node:22\nRUN echo hi\n"),
      mimeType: "application/octet-stream",
    });

    expect(result.content).toBe("FROM node:22\nRUN echo hi\n");
    expect(result.mimeType).toBe("text/plain");
  });

  test("preserves non-ASCII UTF-8 content", () => {
    const result = toTextOnlyReadResult("/NOTES", {
      content: new TextEncoder().encode("café — łódź — 日本語"),
      mimeType: "application/octet-stream",
    });
    expect(result.content).toBe("café — łódź — 日本語");
    expect(result.mimeType).toBe("text/plain");
  });

  test("replaces genuinely binary bytes with a text placeholder", () => {
    const result = toTextOnlyReadResult("/static/logo.png", {
      content: bytes(0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01),
      mimeType: "image/png",
    });

    expect(typeof result.content).toBe("string");
    expect(result.mimeType).toBe("text/plain");
    expect(result.content).toContain("/static/logo.png");
  });

  test("treats UTF-16 text as binary (NUL bytes) rather than emitting garbage", () => {
    // "Hi" encoded as UTF-16LE -> 48 00 69 00. Valid UTF-8 bytewise, but the NUL
    // bytes flag it as non-plain-text, so we placeholder rather than pass it on.
    const result = toTextOnlyReadResult("/utf16.txt", {
      content: bytes(0x48, 0x00, 0x69, 0x00),
      mimeType: "application/octet-stream",
    });
    expect(result.content).toContain("/utf16.txt");
    expect(result.mimeType).toBe("text/plain");
  });

  test("replaces invalid UTF-8 byte sequences with a placeholder", () => {
    // 0xFF is never valid in UTF-8.
    const result = toTextOnlyReadResult("/blob.bin", {
      content: bytes(0xff, 0xfe, 0xfd),
      mimeType: "application/octet-stream",
    });
    expect(result.content).toContain("/blob.bin");
    expect(result.mimeType).toBe("text/plain");
  });

  test("decodes empty binary content to empty text", () => {
    const result = toTextOnlyReadResult("/empty", {
      content: new Uint8Array(0),
      mimeType: "application/octet-stream",
    });
    expect(result.content).toBe("");
    expect(result.mimeType).toBe("text/plain");
  });

  test("does not decode oversized buffers (guards against huge binaries)", () => {
    const huge = new Uint8Array(11 * 1024 * 1024); // all-zero, but over the cap
    const result = toTextOnlyReadResult("/huge.bin", {
      content: huge,
      mimeType: "application/octet-stream",
    });
    expect(result.content).toContain("/huge.bin");
    expect(result.mimeType).toBe("text/plain");
  });
});

describe("createDocumentationBackend", () => {
  test("reads real repository files without ever producing binary content (regression for the OpenAI 'Invalid value: file' 400)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-backend-"));
    await writeFile(
      path.join(repo, "logo.png"),
      Buffer.from(PNG_BASE64, "base64"),
    );
    await writeFile(
      path.join(repo, "LICENSE"),
      "MIT License\nCopyright ...\n",
      "utf8",
    );
    await writeFile(path.join(repo, "Dockerfile"), "FROM node:22\n", "utf8");
    await writeFile(
      path.join(repo, "config.xml"),
      "<root><a/></root>\n",
      "utf8",
    );
    await writeFile(
      path.join(repo, "compose.yaml"),
      "services:\n  app: {}\n",
      "utf8",
    );
    await writeFile(
      path.join(repo, "icon.svg"),
      "<svg xmlns='http://www.w3.org/2000/svg'/>\n",
      "utf8",
    );
    await writeFile(path.join(repo, "README.md"), "# Repo\n", "utf8");

    const backend = createDocumentationBackend(repo);

    // Binary asset -> placeholder, never bytes.
    const png = await backend.read("/logo.png");
    expect(typeof png.content).toBe("string");
    expect(png.mimeType).toBe("text/plain");

    // Extension-less text files -> real content preserved (not skipped).
    const license = await backend.read("/LICENSE");
    expect(typeof license.content).toBe("string");
    expect(license.content).toContain("MIT License");

    const dockerfile = await backend.read("/Dockerfile");
    expect(dockerfile.content).toContain("FROM node:22");

    // Recognized text formats read normally through deepagents itself.
    for (const [file, needle] of [
      ["/config.xml", "<root>"],
      ["/compose.yaml", "services:"],
      ["/icon.svg", "<svg"],
      ["/README.md", "# Repo"],
    ] as const) {
      const result = await backend.read(file);
      expect(typeof result.content).toBe("string");
      expect(result.content).toContain(needle);
    }
  });
});
