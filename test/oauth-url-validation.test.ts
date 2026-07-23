import { afterEach, describe, expect, test, vi } from "vitest";
import {
  discoverAuthorizationServerMetadata,
  validateOAuthEndpointUrl,
} from "../src/auth/oauth-discovery.ts";

describe("validateOAuthEndpointUrl", () => {
  test("allows HTTPS URLs on explicitly allowed hosts", () => {
    expect(
      validateOAuthEndpointUrl(
        "https://api.notion.com/v1/oauth/token",
        "token",
        {
          allowedHosts: ["notion.com"],
        },
      ).toString(),
    ).toBe("https://api.notion.com/v1/oauth/token");
  });

  test.each([
    "http://api.notion.com/v1/oauth/token",
    "https://localhost/token",
    "https://127.0.0.1/token",
    "https://10.0.0.1/token",
    "https://172.16.0.1/token",
    "https://192.168.0.1/token",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/token",
    "https://[fe80::1]/token",
    "https://[fd00::1]/token",
    "https://user:pass@api.notion.com/token",
    "https://attacker.example/token",
  ])("rejects unsafe OAuth endpoint URL %s", (value) => {
    expect(() =>
      validateOAuthEndpointUrl(value, "token", {
        allowedHosts: ["notion.com"],
      }),
    ).toThrow();
  });
});

describe("OAuth discovery fetches", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("does not follow metadata redirects", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 302 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverAuthorizationServerMetadata("https://auth.notion.com/oauth", {
        allowedHosts: ["notion.com"],
      }),
    ).rejects.toThrow(
      "Could not discover OAuth authorization server metadata.",
    );

    expect(fetchMock).toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({ redirect: "manual" });
    }
  });
});
