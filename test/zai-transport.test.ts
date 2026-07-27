import { describe, expect, test, vi } from "vitest";
import {
  createZaiFetch,
  normalizeZaiRequestBody,
  parseZaiRetryAfterMs,
} from "../src/agent/zai-transport.ts";

const ZAI_COMPLETIONS_URL =
  "https://api.z.ai/api/coding/paas/v4/chat/completions";

describe("normalizeZaiRequestBody", () => {
  test("converts only Z.AI file blocks to readable text", () => {
    const normalized = normalizeZaiRequestBody(
      JSON.stringify({
        messages: [
          {
            content: [
              { type: "file", data: "aGVsbG8=" },
              { type: "file", data: "ordinary text" },
              { type: "file", data: "text" },
              {
                type: "file",
                data: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64"),
              },
              { type: "file", data: "" },
              { type: "file" },
              { type: "text", text: "leave this block unchanged" },
            ],
          },
        ],
      }),
    );

    expect(JSON.parse(normalized)).toEqual({
      messages: [
        {
          content: [
            { type: "text", text: "hello" },
            { type: "text", text: "ordinary text" },
            { type: "text", text: "text" },
            { type: "text", text: "[binary file content omitted]" },
            { type: "text", text: "[file content omitted]" },
            { type: "text", text: "[file content omitted]" },
            { type: "text", text: "leave this block unchanged" },
          ],
        },
      ],
    });
  });

  test("leaves malformed or unrelated JSON bodies byte-for-byte unchanged", () => {
    const malformed = '{"messages":';
    const unrelated = JSON.stringify({ request: { file: "not a message" } });

    expect(normalizeZaiRequestBody(malformed)).toBe(malformed);
    expect(normalizeZaiRequestBody(unrelated)).toBe(unrelated);
  });
});

describe("createZaiFetch", () => {
  test("normalizes only Z.AI requests and leaves another provider response untouched", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(new Response("busy", { status: 429 }));
    });
    const sleep = vi.fn(() => Promise.resolve());
    const fetch = createZaiFetch({
      env: { ZAI_RATE_LIMIT_MAX_RETRIES: "0" },
      fetch: fetchImpl,
      sleep,
    });
    const body = JSON.stringify({
      messages: [{ content: [{ type: "file", data: "aGVsbG8=" }] }],
    });

    await fetch(ZAI_COMPLETIONS_URL, { body, method: "POST" });
    await fetch("https://example.test/chat/completions", {
      body,
      method: "POST",
    });

    const firstRequestBody = calls[0]?.init?.body;
    expect(typeof firstRequestBody).toBe("string");
    if (typeof firstRequestBody !== "string") {
      throw new Error("Expected the Z.AI request body to be JSON text.");
    }
    expect(firstRequestBody).toContain('"text":"hello"');
    expect(calls[1]?.init?.body).toBe(body);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("normalizes a Z.AI Request body when fetch is called without init", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response("ok", { status: 200 })),
    );
    const fetch = createZaiFetch({ fetch: fetchImpl });
    const request = new Request(ZAI_COMPLETIONS_URL, {
      body: JSON.stringify({
        messages: [{ content: [{ type: "file", data: "aGVsbG8=" }] }],
      }),
      method: "POST",
    });

    await fetch(request);

    const forwarded = fetchImpl.mock.calls[0]?.[0];
    expect(forwarded).toBeInstanceOf(Request);
    await expect((forwarded as Request).text()).resolves.toContain(
      '"text":"hello"',
    );
  });

  test("uses Retry-After seconds or HTTP dates before exponential fallback", async () => {
    expect(
      parseZaiRetryAfterMs(new Headers({ "retry-after": "2" }), () => 0),
    ).toBe(2_000);
    expect(
      parseZaiRetryAfterMs(
        new Headers({ "retry-after": "Thu, 01 Jan 1970 00:00:03 GMT" }),
        () => 1_000,
      ),
    ).toBe(2_000);

    const sleep = vi.fn(() => Promise.resolve());
    const responses = [
      new Response("limited", { status: 429 }),
      new Response("limited", { status: 429 }),
      new Response("ok", { status: 200 }),
    ];
    const fetch = createZaiFetch({
      env: {
        ZAI_RATE_LIMIT_BASE_DELAY_MS: "10",
        ZAI_RATE_LIMIT_MAX_DELAY_MS: "15",
        ZAI_RATE_LIMIT_MAX_RETRIES: "2",
      },
      fetch: vi.fn(() => Promise.resolve(responses.shift() as Response)),
      sleep,
    });

    await expect(fetch(ZAI_COMPLETIONS_URL)).resolves.toMatchObject({
      status: 200,
    });
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 15]);
  });

  test("recreates a Request body for each Z.AI retry", async () => {
    const requestBodies: string[] = [];
    const responses = [
      new Response("limited", { status: 429 }),
      new Response("ok", { status: 200 }),
    ];
    const fetch = createZaiFetch({
      env: { ZAI_RATE_LIMIT_MAX_RETRIES: "1" },
      fetch: async (input) => {
        if (input instanceof Request) {
          requestBodies.push(await input.text());
        }
        return responses.shift() as Response;
      },
      sleep: () => Promise.resolve(),
    });
    const request = new Request(ZAI_COMPLETIONS_URL, {
      body: JSON.stringify({
        messages: [{ content: [{ type: "file", data: "aGVsbG8=" }] }],
      }),
      method: "POST",
    });

    await expect(fetch(request)).resolves.toMatchObject({ status: 200 });

    expect(requestBodies).toEqual([
      '{"messages":[{"content":[{"type":"text","text":"hello"}]}]}',
      '{"messages":[{"content":[{"type":"text","text":"hello"}]}]}',
    ]);
  });

  test("caps Retry-After, supports disabled retries, and returns the exhausted 429", async () => {
    const cappedSleep = vi.fn(() => Promise.resolve());
    const cappedFetch = createZaiFetch({
      env: {
        ZAI_RATE_LIMIT_MAX_DELAY_MS: "50",
        ZAI_RATE_LIMIT_MAX_RETRIES: "1",
      },
      fetch: vi
        .fn()
        .mockResolvedValueOnce(
          new Response("limited", {
            headers: { "retry-after": "1000" },
            status: 429,
          }),
        )
        .mockResolvedValueOnce(new Response("ok", { status: 200 })),
      sleep: cappedSleep,
    });

    await expect(cappedFetch(ZAI_COMPLETIONS_URL)).resolves.toMatchObject({
      status: 200,
    });
    expect(cappedSleep.mock.calls.map(([delay]) => delay)).toEqual([50]);

    const exhausted = new Response("still limited", { status: 429 });
    const disabledFetch = vi.fn(() => Promise.resolve(exhausted));
    const disabled = createZaiFetch({
      env: { ZAI_RATE_LIMIT_MAX_RETRIES: "0" },
      fetch: disabledFetch,
      sleep: vi.fn(() => Promise.resolve()),
    });

    await expect(disabled(ZAI_COMPLETIONS_URL)).resolves.toBe(exhausted);
    expect(disabledFetch).toHaveBeenCalledTimes(1);
  });
});
