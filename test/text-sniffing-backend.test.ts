import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  TextSniffingLocalShellBackend,
  decodeUtf8Text,
  reinterpretBinaryAsText,
} from "../src/agent/text-sniffing-backend.ts";

describe("decodeUtf8Text", () => {
  test("decodes valid UTF-8 bytes", () => {
    const bytes = new TextEncoder().encode("server.port=8080\n# café");
    expect(decodeUtf8Text(bytes)).toBe("server.port=8080\n# café");
  });

  test("returns null when bytes contain a NUL byte", () => {
    const bytes = new Uint8Array([0x68, 0x69, 0x00, 0x21]);
    expect(decodeUtf8Text(bytes)).toBeNull();
  });

  test("returns null for invalid UTF-8", () => {
    // 0xff is never valid as a standalone UTF-8 byte.
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    expect(decodeUtf8Text(bytes)).toBeNull();
  });

  test("decodes empty input to an empty string", () => {
    expect(decodeUtf8Text(new Uint8Array())).toBe("");
  });
});

describe("reinterpretBinaryAsText", () => {
  const bytesOf = (s: string) => new TextEncoder().encode(s);

  test("passes error results through unchanged", () => {
    const result = { error: "File 'x' not found" };
    expect(reinterpretBinaryAsText(result, 0, 500)).toBe(result);
  });

  test("passes text (string) results through unchanged", () => {
    const result = { content: "already text", mimeType: "text/plain" };
    expect(reinterpretBinaryAsText(result, 0, 500)).toBe(result);
  });

  test("converts valid-UTF-8 binary content to text/plain", () => {
    const result = {
      content: bytesOf("a=1\nb=2\n"),
      mimeType: "application/octet-stream",
    };
    const out = reinterpretBinaryAsText(result, 0, 500);
    expect(out.mimeType).toBe("text/plain");
    expect(out.content).toBe("a=1\nb=2\n");
  });

  test("leaves genuinely binary content untouched", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
    const result = { content: bytes, mimeType: "application/octet-stream" };
    const out = reinterpretBinaryAsText(result, 0, 500);
    expect(out.content).toBe(bytes);
    expect(out.mimeType).toBe("application/octet-stream");
  });

  test("applies offset/limit line windowing", () => {
    const result = {
      content: bytesOf("l1\nl2\nl3\nl4\nl5"),
      mimeType: "application/octet-stream",
    };
    expect(reinterpretBinaryAsText(result, 1, 2).content).toBe("l2\nl3");
  });

  test("reports an out-of-range offset as an error", () => {
    const result = {
      content: bytesOf("only\ntwo"),
      mimeType: "application/octet-stream",
    };
    expect(reinterpretBinaryAsText(result, 10, 500).error).toMatch(
      /exceeds file length/,
    );
  });
});

describe("TextSniffingLocalShellBackend (integration)", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "openwiki-sniff-"));
    await writeFile(
      path.join(root, "application.properties"),
      "server.port=8080\nspring.datasource.url=jdbc:postgresql://db\n",
    );
    await writeFile(
      path.join(root, "styles.scss"),
      "$primary: #FF6B35;\n.button { color: $primary; }\n",
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("reads an unknown-extension text file as readable text", async () => {
    const backend = new TextSniffingLocalShellBackend({
      rootDir: root,
      virtualMode: true,
    });
    const result = await backend.read("/application.properties");
    expect(result.error).toBeUndefined();
    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("server.port=8080");
  });

  test("reads a .scss file as readable text", async () => {
    const backend = new TextSniffingLocalShellBackend({
      rootDir: root,
      virtualMode: true,
    });
    const result = await backend.read("/styles.scss");
    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("$primary");
  });
});
