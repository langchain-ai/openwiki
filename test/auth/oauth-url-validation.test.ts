import { afterEach, describe, expect, test, vi } from "vitest";
import {
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
  validateOAuthEndpointUrl,
} from "../../src/auth/oauth-discovery.ts";

/**
 * Builds a `fetch` double that replays queued `Response`s in order, so a test
 * can model the candidate-path fallback (first .well-known miss, second hit)
 * without touching the network.
 */
function fetchReturning(...responses: Response[]): ReturnType<typeof vi.fn> {
  const queue = [...responses];
  return vi.fn(() =>
    Promise.resolve(queue.shift() ?? new Response(null, { status: 404 })),
  );
}

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
    "https://[fc00::1]/token",
    // IPv4-mapped IPv6 is a classic SSRF bypass: the loopback and cloud
    // metadata address must stay blocked when smuggled through ::ffff:.
    "https://[::ffff:127.0.0.1]/token",
    "https://[::ffff:169.254.169.254]/token",
    // A globally-routable IPv6 is not a private range, so it clears the SSRF
    // guard, but it is still off the allowlist and must be refused.
    "https://[2606:4700::1]/token",
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

  test("returns the parsed authorization-server metadata on the first hit", async () => {
    // The discovery document is attacker-influenceable, so this only asserts
    // that a 200 body is surfaced verbatim; shape validation (required
    // endpoints) is the caller's responsibility, exercised in the OAuth flow.
    const fetchMock = fetchReturning(
      new Response(
        JSON.stringify({
          authorization_endpoint: "https://auth.notion.com/authorize",
          token_endpoint: "https://auth.notion.com/token",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverAuthorizationServerMetadata("https://auth.notion.com/oauth", {
        allowedHosts: ["notion.com"],
      }),
    ).resolves.toMatchObject({
      authorization_endpoint: "https://auth.notion.com/authorize",
    });
  });
});

describe("discoverProtectedResourceMetadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("returns the advertised authorization servers from the metadata", async () => {
    const fetchMock = fetchReturning(
      new Response(
        JSON.stringify({
          authorization_servers: ["https://auth.notion.com"],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverProtectedResourceMetadata("https://mcp.notion.com/mcp", {
        allowedHosts: ["notion.com"],
      }),
    ).resolves.toMatchObject({
      authorization_servers: ["https://auth.notion.com"],
    });
  });

  test("falls back to the bare .well-known path when the first candidate misses", async () => {
    // A 404 on the path-scoped document must not abort discovery; the origin
    // .well-known document is tried next before giving up.
    const fetchMock = fetchReturning(
      new Response(null, { status: 404 }),
      new Response(
        JSON.stringify({ authorization_servers: ["https://auth.notion.com"] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverProtectedResourceMetadata("https://mcp.notion.com/mcp", {
        allowedHosts: ["notion.com"],
      }),
    ).resolves.toMatchObject({
      authorization_servers: ["https://auth.notion.com"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("throws when no candidate returns metadata", async () => {
    const fetchMock = fetchReturning(
      new Response(null, { status: 404 }),
      new Response(null, { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverProtectedResourceMetadata("https://mcp.notion.com/mcp", {
        allowedHosts: ["notion.com"],
      }),
    ).rejects.toThrow("Could not discover MCP protected resource metadata.");
  });

  test("refuses to fetch when the resource URL fails the SSRF guard", async () => {
    // The resource URL is untrusted input; a loopback target must be rejected
    // by validateOAuthEndpointUrl before any fetch, closing the SSRF path
    // toward internal/metadata services.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverProtectedResourceMetadata("https://127.0.0.1/mcp", {
        allowedHosts: ["notion.com"],
      }),
    ).rejects.toThrow(/localhost or private networks/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("does not follow protected-resource metadata redirects", async () => {
    const fetchMock = fetchReturning(
      new Response(null, { status: 302 }),
      new Response(null, { status: 302 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverProtectedResourceMetadata("https://mcp.notion.com/mcp", {
        allowedHosts: ["notion.com"],
      }),
    ).rejects.toThrow("Could not discover MCP protected resource metadata.");
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({ redirect: "manual" });
    }
  });
});
