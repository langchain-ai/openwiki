import { describe, expect, test } from "vitest";
import {
  applyLineWindow,
  sniffBinaryReadResultAsText,
} from "../src/agent/text-backend.ts";

const encoder = new TextEncoder();

describe("sniffBinaryReadResultAsText", () => {
  test("converts valid UTF-8 byte content to text/plain", () => {
    const result = sniffBinaryReadResultAsText({
      content: encoder.encode('region = "us-east-1"\n'),
      mimeType: "application/octet-stream",
    });

    expect(result).toEqual({
      content: 'region = "us-east-1"\n',
      mimeType: "text/plain",
    });
  });

  test("applies line offset and limit to sniffed text", () => {
    const result = sniffBinaryReadResultAsText(
      {
        content: encoder.encode("first\nsecond\nthird\nfourth"),
        mimeType: "application/octet-stream",
      },
      1,
      2,
    );

    expect(result?.content).toBe("second\nthird");
  });

  test("leaves invalid UTF-8 byte content unchanged", () => {
    const result = sniffBinaryReadResultAsText({
      content: new Uint8Array([0xff, 0xfe, 0xfd]),
      mimeType: "application/octet-stream",
    });

    expect(result).toBeNull();
  });

  test("leaves NUL-containing byte content unchanged", () => {
    const result = sniffBinaryReadResultAsText({
      content: new Uint8Array([0x61, 0x00, 0x62]),
      mimeType: "application/octet-stream",
    });

    expect(result).toBeNull();
  });

  test("ignores already-text read results", () => {
    const result = sniffBinaryReadResultAsText({
      content: "already text",
      mimeType: "text/plain",
    });

    expect(result).toBeNull();
  });
});

describe("applyLineWindow", () => {
  test("normalizes negative offset and limit", () => {
    expect(applyLineWindow("first\nsecond", -1, -1)).toBe("");
  });

  test("keeps the default 500-line window", () => {
    const text = Array.from({ length: 501 }, (_, index) => String(index)).join(
      "\n",
    );

    expect(applyLineWindow(text).split("\n")).toHaveLength(500);
  });
});
