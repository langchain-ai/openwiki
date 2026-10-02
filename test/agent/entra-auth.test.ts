import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AccessToken } from "@azure/identity";
import { createEntraTokenProvider } from "../../src/agent/entra-auth.ts";

const identityMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  getToken:
    vi.fn<
      (
        scopes: string | string[],
        options?: unknown,
      ) => Promise<AccessToken | null>
    >(),
}));

vi.mock("@azure/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/identity")>();

  return {
    ...actual,
    DefaultAzureCredential: class {
      constructor() {
        identityMocks.construct();
      }

      getToken(scopes: string | string[], options?: unknown) {
        return identityMocks.getToken(scopes, options);
      }
    },
  };
});

const BASE_URL = "https://gateway.example.com/openai/v1";
const SCOPE = "api://gateway/.default";
const TOKEN_LIFETIME_MS = 10 * 60 * 1000;

function accessToken(token: string, lifetimeMs = TOKEN_LIFETIME_MS) {
  return { token, expiresOnTimestamp: Date.now() + lifetimeMs };
}

beforeEach(() => {
  identityMocks.construct.mockReset();
  identityMocks.getToken.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createEntraTokenProvider", () => {
  test("constructs Azure Identity lazily and coalesces concurrent first requests", async () => {
    identityMocks.getToken.mockResolvedValue(accessToken("first-token"));
    const getToken = createEntraTokenProvider(BASE_URL, SCOPE);

    expect(identityMocks.construct).not.toHaveBeenCalled();
    expect(identityMocks.getToken).not.toHaveBeenCalled();

    expect(await Promise.all([getToken(), getToken(), getToken()])).toEqual([
      "first-token",
      "first-token",
      "first-token",
    ]);
    expect(identityMocks.construct).toHaveBeenCalledTimes(1);
    expect(identityMocks.getToken).toHaveBeenCalledTimes(1);
    expect(identityMocks.getToken).toHaveBeenCalledWith(
      [SCOPE],
      expect.any(Object),
    );
  });

  test("reuses the cached token while it remains valid", async () => {
    identityMocks.getToken.mockResolvedValue(accessToken("cached-token"));
    const getToken = createEntraTokenProvider(BASE_URL, SCOPE);

    expect(await getToken()).toBe("cached-token");
    expect(await getToken()).toBe("cached-token");
    expect(identityMocks.getToken).toHaveBeenCalledTimes(1);
  });

  test("refreshes an expired token without reconstructing the provider", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    identityMocks.getToken
      .mockResolvedValueOnce(accessToken("old-token", 5 * 60 * 1000))
      .mockImplementationOnce(() => Promise.resolve(accessToken("new-token")));
    const getToken = createEntraTokenProvider(BASE_URL, SCOPE);

    expect(await getToken()).toBe("old-token");
    vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z"));
    expect(await getToken()).toBe("new-token");
    expect(identityMocks.construct).toHaveBeenCalledTimes(1);
    expect(identityMocks.getToken).toHaveBeenCalledTimes(2);
  });

  test("retries token acquisition after a failure without exposing the SDK error", async () => {
    identityMocks.getToken
      .mockRejectedValueOnce(
        new Error("JWT and client secret must stay private"),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(accessToken("recovered-token")),
      );
    const getToken = createEntraTokenProvider(BASE_URL, SCOPE);

    const failure = await getToken().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "Unable to obtain a Microsoft Entra ID access token.",
    );
    expect((failure as Error).message).not.toContain("JWT and client secret");
    expect((failure as Error).cause).toBeUndefined();
    expect(await getToken()).toBe("recovered-token");
    expect(identityMocks.construct).toHaveBeenCalledTimes(1);
    expect(identityMocks.getToken).toHaveBeenCalledTimes(2);
  });

  test("retries lazy initialization after a constructor failure", async () => {
    identityMocks.construct.mockImplementationOnce(() => {
      throw new Error("private certificate password");
    });
    identityMocks.getToken.mockResolvedValue(accessToken("recovered-token"));
    const getToken = createEntraTokenProvider(BASE_URL, SCOPE);

    await expect(getToken()).rejects.toThrow(
      "Unable to obtain a Microsoft Entra ID access token.",
    );
    expect(await getToken()).toBe("recovered-token");
    expect(identityMocks.construct).toHaveBeenCalledTimes(2);
  });

  test.each([
    undefined,
    "not a URL",
    "http://gateway.example.com/v1",
    "file:///tmp/gateway",
    "gopher://gateway.example.com",
    "ftp://gateway.example.com",
    "data:text/plain,hello",
    "https://user:password@gateway.example.com/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://metadata.google.internal/v1",
    "https://metadata.google.internal./v1",
  ])("rejects an unsafe endpoint before acquiring credentials: %s", (url) => {
    expect(() => createEntraTokenProvider(url, SCOPE)).toThrow(
      /Entra ID authentication requires an HTTPS OPENAI_COMPATIBLE_BASE_URL/u,
    );
    expect(identityMocks.construct).not.toHaveBeenCalled();
    expect(identityMocks.getToken).not.toHaveBeenCalled();
  });
});
