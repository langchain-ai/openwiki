import { describe, expect, test, vi } from "vitest";

// startNgrokTunnel persists the resolved redirect config through the env file.
// It is mocked so the validation-rejection cases below cannot touch disk; those
// cases all throw during validatePort / normalizeNgrokUrl, before any save or
// `ngrok` spawn, so no real tunnel process is ever launched here.
vi.mock("../../src/config/env.ts", () => ({
  saveOpenWikiEnv: vi.fn(() => Promise.resolve()),
}));

import {
  getRedirectUriFromNgrokTunnels,
  startNgrokTunnel,
} from "../../src/auth/ngrok.ts";

const PORT = 53682;

/**
 * Builds an ngrok `/api/tunnels` style payload from tunnel descriptors.
 */
function tunnels(entries: { addr?: string; public_url: string }[]): {
  tunnels: unknown[];
} {
  return {
    tunnels: entries.map(({ addr, public_url }) => ({
      config: addr === undefined ? {} : { addr },
      public_url,
    })),
  };
}

describe("getRedirectUriFromNgrokTunnels", () => {
  test("returns null when the payload is not a tunnels object", () => {
    expect(getRedirectUriFromNgrokTunnels(null, PORT)).toBeNull();
    expect(getRedirectUriFromNgrokTunnels({}, PORT)).toBeNull();
    expect(
      getRedirectUriFromNgrokTunnels({ tunnels: "nope" }, PORT),
    ).toBeNull();
  });

  test("builds a callback URL from the tunnel whose addr matches the port", () => {
    const payload = tunnels([
      { addr: "localhost:1111", public_url: "https://other.ngrok.app" },
      { addr: "http://localhost:53682", public_url: "https://match.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://match.ngrok.app/callback",
    );
  });

  test("matches a bare port addr and strips a trailing slash", () => {
    const payload = tunnels([
      { addr: String(PORT), public_url: "https://match.ngrok.app/" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://match.ngrok.app/callback",
    );
  });

  test("falls back to the sole https tunnel when none match the port", () => {
    const payload = tunnels([
      { addr: "localhost:9999", public_url: "https://only.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://only.ngrok.app/callback",
    );
  });

  test("returns null when several tunnels exist but none match the port", () => {
    const payload = tunnels([
      { addr: "localhost:1111", public_url: "https://a.ngrok.app" },
      { addr: "localhost:2222", public_url: "https://b.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBeNull();
  });

  test("ignores non-https tunnels", () => {
    const payload = tunnels([
      { addr: `localhost:${PORT}`, public_url: "http://insecure.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBeNull();
  });

  test("ignores tunnels whose public url carries a port, query, or credentials", () => {
    const payload = tunnels([
      { addr: `localhost:${PORT}`, public_url: "https://a.ngrok.app:8443" },
      { addr: `localhost:${PORT}`, public_url: "https://b.ngrok.app?x=1" },
      { addr: `localhost:${PORT}`, public_url: "https://user:pw@c.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBeNull();
  });

  test("skips tunnel entries that are not objects or lack a public url", () => {
    // The ngrok API is trusted loosely: a null entry or one missing public_url
    // must be dropped rather than crash discovery, while a valid sibling still
    // resolves.
    const payload = {
      tunnels: [
        null,
        { config: { addr: `localhost:${PORT}` } },
        { config: { addr: `localhost:${PORT}` }, public_url: 42 },
        {
          config: { addr: `localhost:${PORT}` },
          public_url: "https://ok.ngrok.app",
        },
      ],
    };

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://ok.ngrok.app/callback",
    );
  });

  test("skips tunnels whose public url does not parse", () => {
    const payload = tunnels([
      { addr: `localhost:${PORT}`, public_url: "://not-a-url" },
      { addr: `localhost:${PORT}`, public_url: "https://parses.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://parses.ngrok.app/callback",
    );
  });

  test("treats a tunnel with no addr as non-matching but still usable as the sole fallback", () => {
    // A tunnel config lacking an `addr` yields an empty string; the port match
    // short-circuits to false rather than throwing, and the sole https tunnel
    // is still returned as the fallback.
    const payload = tunnels([
      { addr: undefined, public_url: "https://noaddr.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://noaddr.ngrok.app/callback",
    );
  });

  test("treats an unparseable addr as non-matching without throwing", () => {
    // A non-empty addr that is neither a bare port, a `:port` suffix, nor a
    // parseable URL must fail the port match via the caught URL parse error,
    // leaving the sole https tunnel as the fallback.
    const payload = tunnels([
      { addr: "garbage", public_url: "https://weirdaddr.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://weirdaddr.ngrok.app/callback",
    );
  });

  test("matches a full-url addr by parsing out its port", () => {
    // The addr is a full URL that does not literally end in `:53682`, so the
    // match must come from URL parsing rather than the suffix shortcut.
    const payload = tunnels([
      {
        addr: "http://127.0.0.1:53682/callback",
        public_url: "https://a.ngrok.app",
      },
      {
        addr: "http://127.0.0.1:9999/callback",
        public_url: "https://b.ngrok.app",
      },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://a.ngrok.app/callback",
    );
  });

  test("does not match a full-url addr whose parsed port differs", () => {
    const payload = tunnels([
      {
        addr: "http://127.0.0.1:1111/callback",
        public_url: "https://a.ngrok.app",
      },
      {
        addr: "http://127.0.0.1:2222/callback",
        public_url: "https://b.ngrok.app",
      },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBeNull();
  });
});

describe("startNgrokTunnel validation", () => {
  // Every case here rejects during synchronous validation, before saveOpenWikiEnv
  // or the ngrok spawn, so a bad operator input never brings up a tunnel.
  test.each([80, 70000, 1024.5])(
    "rejects a local port outside the unprivileged TCP range: %s",
    async (port) => {
      await expect(startNgrokTunnel({ port })).rejects.toThrow(
        "ngrok local port must be between 1024 and 65535.",
      );
    },
  );

  test("rejects a custom url that is not https", async () => {
    // A plaintext tunnel would ship the OAuth redirect over http, so it is
    // refused rather than silently downgraded.
    await expect(
      startNgrokTunnel({ url: "http://tunnel.ngrok.app" }),
    ).rejects.toThrow("ngrok custom URL must use https.");
  });

  test("rejects a custom url that carries credentials, query, or fragment", async () => {
    for (const url of [
      "https://user:pw@tunnel.ngrok.app",
      "https://tunnel.ngrok.app/?token=abc",
      "https://tunnel.ngrok.app/#frag",
    ]) {
      await expect(startNgrokTunnel({ url })).rejects.toThrow(
        "ngrok custom URL must not include credentials, query, or fragment.",
      );
    }
  });

  test("rejects a custom url that pins a port", async () => {
    await expect(
      startNgrokTunnel({ url: "https://tunnel.ngrok.app:8443" }),
    ).rejects.toThrow("ngrok custom URL must not include a port.");
  });

  test("rejects a custom url whose path is neither empty nor /callback", async () => {
    await expect(
      startNgrokTunnel({ url: "https://tunnel.ngrok.app/elsewhere" }),
    ).rejects.toThrow("ngrok custom URL path must be empty or /callback.");
  });

  test("rejects a custom url without a valid dns hostname", async () => {
    // Underscores are not legal DNS label characters; the hostname guard keeps
    // a bogus authority from being registered as a Slack redirect.
    await expect(startNgrokTunnel({ url: "https://bad_host" })).rejects.toThrow(
      "ngrok custom URL must include a valid DNS hostname.",
    );
  });
});
