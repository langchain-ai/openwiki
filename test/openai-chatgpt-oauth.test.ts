import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CHATGPT_TOKEN_REFRESH_THRESHOLD_MS,
  decodeChatGptIdentity,
  isChatGptTokenExpired,
  parseManualCallbackInput,
  refreshChatGptTokens,
} from "../src/agent/openai-chatgpt-oauth.ts";

function makeAccessToken(
  accountId: string | null,
  extra: { email?: string; planType?: string } = {},
): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const auth: Record<string, unknown> = {};

  if (accountId !== null) {
    auth.chatgpt_account_id = accountId;
  }

  if (extra.planType !== undefined) {
    auth.chatgpt_plan_type = extra.planType;
  }

  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": auth,
      ...(extra.email !== undefined
        ? { "https://api.openai.com/profile": { email: extra.email } }
        : {}),
    }),
  ).toString("base64url");

  return `${header}.${payload}.signature`;
}

function stubTokenResponse(
  body: unknown,
  status = 200,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
      }),
  );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refreshChatGptTokens", () => {
  test("parses tokens and decodes identity from the access JWT", async () => {
    const access = makeAccessToken("acct_abc123", {
      email: "dev@example.com",
      planType: "plus",
    });
    const fetchMock = stubTokenResponse({
      access_token: access,
      refresh_token: "refresh-next",
      expires_in: 3600,
    });

    const before = Date.now();
    const tokens = await refreshChatGptTokens("refresh-prev");

    expect(tokens.access).toBe(access);
    expect(tokens.refresh).toBe("refresh-next");
    expect(tokens.accountId).toBe("acct_abc123");
    expect(tokens.email).toBe("dev@example.com");
    expect(tokens.planType).toBe("plus");
    expect(tokens.expiresAtMs).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(tokens.expiresAtMs).toBeLessThanOrEqual(Date.now() + 3600 * 1000);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    const sentBody = String(init.body);
    expect(sentBody).toContain("grant_type=refresh_token");
    expect(sentBody).toContain("refresh_token=refresh-prev");
  });

  test("throws when a required field is missing", async () => {
    stubTokenResponse({
      access_token: makeAccessToken("acct_abc123"),
      expires_in: 3600,
    });

    await expect(refreshChatGptTokens("refresh-prev")).rejects.toThrow(
      /missing required fields.*refresh_token/u,
    );
  });

  test("throws when the account id cannot be decoded", async () => {
    stubTokenResponse({
      access_token: makeAccessToken(null),
      refresh_token: "refresh-next",
      expires_in: 3600,
    });

    await expect(refreshChatGptTokens("refresh-prev")).rejects.toThrow(
      /account id/u,
    );
  });

  test("throws on a non-2xx response", async () => {
    stubTokenResponse("nope", 401);

    await expect(refreshChatGptTokens("refresh-prev")).rejects.toThrow(
      /token request failed \(401\)/u,
    );
  });
});

describe("isChatGptTokenExpired", () => {
  const now = 1_000_000;

  test("is not expired well before expiry", () => {
    expect(isChatGptTokenExpired(now + 10 * 60 * 1000, now)).toBe(false);
  });

  test("is expired once past expiry", () => {
    expect(isChatGptTokenExpired(now - 1, now)).toBe(true);
  });

  test("is expired within the near-expiry threshold", () => {
    expect(
      isChatGptTokenExpired(now + CHATGPT_TOKEN_REFRESH_THRESHOLD_MS - 1, now),
    ).toBe(true);
  });

  test("treats a non-numeric expiry as expired", () => {
    expect(isChatGptTokenExpired(Number.NaN, now)).toBe(true);
  });
});

describe("decodeChatGptIdentity", () => {
  test("decodes account id, email, and plan", () => {
    const token = makeAccessToken("acct_1", {
      email: "a@b.com",
      planType: "pro",
    });

    expect(decodeChatGptIdentity(token)).toEqual({
      accountId: "acct_1",
      email: "a@b.com",
      planType: "pro",
    });
  });

  test("returns nulls for missing claims or malformed tokens", () => {
    expect(decodeChatGptIdentity(makeAccessToken("acct_1"))).toEqual({
      accountId: "acct_1",
      email: null,
      planType: null,
    });
    expect(decodeChatGptIdentity("not-a-jwt")).toEqual({
      accountId: null,
      email: null,
      planType: null,
    });
  });
});

describe("parseManualCallbackInput", () => {
  test("extracts code and state from a full redirect URL", () => {
    expect(
      parseManualCallbackInput(
        "http://localhost:1455/auth/callback?code=ac_123&scope=openid&state=abc",
      ),
    ).toEqual({ code: "ac_123", state: "abc" });
  });

  test("extracts code and state from a bare query string", () => {
    expect(parseManualCallbackInput("code=ac_123&state=abc")).toEqual({
      code: "ac_123",
      state: "abc",
    });
    expect(parseManualCallbackInput("?code=ac_123&state=abc")).toEqual({
      code: "ac_123",
      state: "abc",
    });
  });

  test("treats a bare value as the code with no state", () => {
    expect(parseManualCallbackInput("  ac_123  ")).toEqual({
      code: "ac_123",
      state: null,
    });
  });

  test("returns null code for empty input", () => {
    expect(parseManualCallbackInput("   ")).toEqual({
      code: null,
      state: null,
    });
  });

  test("returns null code when a URL has no code param", () => {
    expect(
      parseManualCallbackInput("http://localhost:1455/auth/callback?state=abc"),
    ).toEqual({ code: null, state: "abc" });
  });
});
