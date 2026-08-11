import { afterEach, describe, expect, test, vi } from "vitest";
import {
  XAI_GROK_TOKEN_REFRESH_THRESHOLD_MS,
  type XaiGrokTokens,
  hasValidXaiGrokTokens,
  isXaiGrokTokenExpired,
  parseManualCallbackInput,
  readXaiGrokTokensFromEnv,
  refreshXaiGrokTokens,
  xaiGrokTokensToEnv,
} from "../../src/agent/xai-grok-oauth.ts";

function stubTokenResponse(
  body: unknown,
  status = 200,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
      }),
    ),
  );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refreshXaiGrokTokens", () => {
  test("parses tokens from the refresh response", async () => {
    const fetchMock = stubTokenResponse({
      access_token: "access-next",
      refresh_token: "refresh-next",
      expires_in: 3600,
    });

    const before = Date.now();
    const tokens = await refreshXaiGrokTokens("refresh-prev");

    expect(tokens.access).toBe("access-next");
    expect(tokens.refresh).toBe("refresh-next");
    expect(tokens.expiresAtMs).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(tokens.expiresAtMs).toBeLessThanOrEqual(Date.now() + 3600 * 1000);

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { body: URLSearchParams },
    ];
    expect(url).toBe("https://auth.x.ai/oauth2/token");
    const sentBody = init.body.toString();
    expect(sentBody).toContain("grant_type=refresh_token");
    expect(sentBody).toContain("refresh_token=refresh-prev");
  });

  test("keeps the previous refresh token when the response omits one", async () => {
    stubTokenResponse({
      access_token: "access-next",
      expires_in: 900,
    });

    const tokens = await refreshXaiGrokTokens("refresh-prev");

    expect(tokens.refresh).toBe("refresh-prev");
  });

  test("throws a sign-in-again error on invalid_grant", async () => {
    stubTokenResponse(
      { error: "invalid_grant", error_description: "revoked" },
      400,
    );

    await expect(refreshXaiGrokTokens("refresh-prev")).rejects.toThrow(
      /Sign in again/u,
    );
  });

  test("throws on a non-2xx response", async () => {
    stubTokenResponse("nope", 401);

    await expect(refreshXaiGrokTokens("refresh-prev")).rejects.toThrow(
      /token request failed \(401\)/u,
    );
  });
});

describe("isXaiGrokTokenExpired", () => {
  const now = 1_000_000;

  test("is not expired well before expiry", () => {
    expect(isXaiGrokTokenExpired(now + 10 * 60 * 1000, now)).toBe(false);
  });

  test("is expired once past expiry", () => {
    expect(isXaiGrokTokenExpired(now - 1, now)).toBe(true);
  });

  test("is expired within the near-expiry threshold", () => {
    expect(
      isXaiGrokTokenExpired(now + XAI_GROK_TOKEN_REFRESH_THRESHOLD_MS - 1, now),
    ).toBe(true);
  });

  test("treats a non-numeric expiry as expired", () => {
    expect(isXaiGrokTokenExpired(Number.NaN, now)).toBe(true);
  });
});

describe("xai grok token env contract", () => {
  const tokens: XaiGrokTokens = {
    access: "access-1",
    refresh: "refresh-1",
    expiresAtMs: 1_700_000_000_000,
  };

  test("round-trips tokens through the environment", () => {
    const env = xaiGrokTokensToEnv(tokens);

    expect(env).toEqual({
      XAI_GROK_ACCESS_TOKEN: "access-1",
      XAI_GROK_REFRESH_TOKEN: "refresh-1",
      XAI_GROK_EXPIRES_AT: "1700000000000",
    });
    expect(readXaiGrokTokensFromEnv(env)).toEqual(tokens);
  });

  test("returns null for incomplete env sets", () => {
    expect(
      readXaiGrokTokensFromEnv({
        XAI_GROK_ACCESS_TOKEN: "access-only",
      }),
    ).toBeNull();
  });

  test("hasValidXaiGrokTokens requires a non-expired complete set", () => {
    const env = {
      XAI_GROK_ACCESS_TOKEN: "a",
      XAI_GROK_REFRESH_TOKEN: "r",
      XAI_GROK_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
    };

    expect(hasValidXaiGrokTokens(env)).toBe(true);
    expect(
      hasValidXaiGrokTokens({
        ...env,
        XAI_GROK_EXPIRES_AT: String(Date.now() - 1),
      }),
    ).toBe(false);
  });
});

describe("parseManualCallbackInput", () => {
  test("parses redirect URLs, query strings, and bare codes", () => {
    expect(
      parseManualCallbackInput(
        "http://127.0.0.1:1456/callback?code=abc&state=xyz",
      ),
    ).toEqual({ code: "abc", state: "xyz" });
    expect(parseManualCallbackInput("code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
    expect(parseManualCallbackInput("abc")).toEqual({
      code: "abc",
      state: null,
    });
  });
});
