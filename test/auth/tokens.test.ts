import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseEnv } from "../../src/config/env.ts";
import { getAuthProvider } from "../../src/auth/providers.ts";
import type { AuthProviderId } from "../../src/auth/types.ts";

// tokens.ts persists refreshed credentials by delegating to saveOpenWikiEnv,
// which writes ~/.openwiki/.env. These tests exercise that real persistence
// path (rather than mocking the env layer) so the on-disk permission invariant
// can be asserted end to end. Only fetch is stubbed; a real network call to a
// provider token endpoint is never made. os.homedir() is read at module load,
// so every test loads tokens.ts fresh under a throwaway HOME.

const PROVIDER_IDS: AuthProviderId[] = ["gmail", "notion", "slack", "x"];

/**
 * Every process.env key any provider's token mapping can read or write.
 * Collected up front so each test starts from a clean slate: saveOpenWikiEnv
 * mirrors persisted values back into process.env, so without this reset a
 * refreshed token would leak into the next test's expiry/cache assertions.
 */
const managedKeys = collectManagedKeys();

function collectManagedKeys(): string[] {
  const keys = new Set<string>();

  for (const providerId of PROVIDER_IDS) {
    const provider = getAuthProvider(providerId);
    const mapping = provider.tokenMapping;

    keys.add(mapping.accessTokenEnvKey);

    for (const key of [
      mapping.refreshTokenEnvKey,
      mapping.expiresAtEnvKey,
      mapping.tokenTypeEnvKey,
      mapping.clientIdEnvKey,
      provider.clientIdEnvKey,
      provider.clientSecretEnvKey,
    ]) {
      if (key) {
        keys.add(key);
      }
    }
  }

  return [...keys];
}

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const savedManaged: Record<string, string | undefined> = {};
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-tokens-"));
  tempHomes.push(home);
  return home;
}

/**
 * Load a fresh tokens.ts bound to the given HOME. resetModules is required
 * because env.ts captures os.homedir() into a module-level constant at import
 * time, so the temp HOME must be set before the (re)import.
 */
async function loadTokensModule(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  // Windows resolves the home directory from USERPROFILE, not HOME; set both so
  // the temp-HOME redirection holds regardless of platform.
  process.env.USERPROFILE = home;
  return await import("../../src/auth/tokens.ts");
}

/**
 * Stub global fetch with a real Response so tokens.ts sees genuine ok/status
 * and json() semantics. Returns the mock for request-body inspection.
 */
function stubFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
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

/**
 * Stub fetch to fail loudly. Used where tokens.ts must reject before ever
 * reaching the network, so a real request would be a bug the test should catch.
 */
function stubFetchNeverCalled(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => {
    throw new Error("fetch must not be called on this path");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function envDirFor(home: string): string {
  return path.join(home, ".openwiki");
}

function envPathFor(home: string): string {
  return path.join(envDirFor(home), ".env");
}

async function readPersistedEnv(home: string): Promise<Record<string, string>> {
  return parseEnv(await readFile(envPathFor(home), "utf8"));
}

beforeEach(() => {
  for (const key of managedKeys) {
    savedManaged[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.resetModules();

  for (const key of managedKeys) {
    if (savedManaged[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedManaged[key];
    }
  }

  restoreEnv("HOME", originalHome);
  restoreEnv("USERPROFILE", originalUserProfile);

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("getOAuthProviderIdForAccessTokenEnvKey", () => {
  test("maps each provider's access-token env key back to its id", async () => {
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);

    for (const providerId of PROVIDER_IDS) {
      const accessKey =
        getAuthProvider(providerId).tokenMapping.accessTokenEnvKey;
      expect(tokens.getOAuthProviderIdForAccessTokenEnvKey(accessKey)).toBe(
        providerId,
      );
    }
  });

  test("returns null for an env key no provider owns", async () => {
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);

    expect(
      tokens.getOAuthProviderIdForAccessTokenEnvKey("OPENWIKI_NOT_A_TOKEN"),
    ).toBeNull();
  });
});

describe("isOAuthAccessTokenExpired", () => {
  const EXPIRES_KEY = getAuthProvider("slack").tokenMapping.expiresAtEnvKey!;

  test("treats a missing expiry as not expired", async () => {
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);

    expect(tokens.isOAuthAccessTokenExpired("slack")).toBe(false);
  });

  test("treats an unparseable expiry as expired", async () => {
    // A corrupt timestamp should fail safe toward refreshing, never toward
    // handing back a token whose validity cannot be established.
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    process.env[EXPIRES_KEY] = "not-a-timestamp";

    expect(tokens.isOAuthAccessTokenExpired("slack")).toBe(true);
  });

  test("treats a comfortably future expiry as not expired", async () => {
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    process.env[EXPIRES_KEY] = new Date(Date.now() + 600_000).toISOString();

    expect(tokens.isOAuthAccessTokenExpired("slack")).toBe(false);
  });

  test("treats an already-past expiry as expired", async () => {
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    process.env[EXPIRES_KEY] = new Date(Date.now() - 1_000).toISOString();

    expect(tokens.isOAuthAccessTokenExpired("slack")).toBe(true);
  });

  test("treats an expiry inside the 60s refresh skew as expired", async () => {
    // The skew (REFRESH_EXPIRY_SKEW_MS = 60s) forces a proactive refresh: a
    // token expiring 30s from now is already treated as expired so a request
    // is never sent with a credential about to lapse mid-flight.
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    process.env[EXPIRES_KEY] = new Date(Date.now() + 30_000).toISOString();

    expect(tokens.isOAuthAccessTokenExpired("slack")).toBe(true);
  });
});

describe("refreshOAuthAccessToken persistence", () => {
  const isPosix = process.platform !== "win32";

  test("writes the refreshed env to a 0o600 file inside a 0o700 dir", async () => {
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    const gmail = getAuthProvider("gmail");

    process.env[gmail.tokenMapping.refreshTokenEnvKey!] = "gmail-refresh";
    process.env[gmail.clientIdEnvKey!] = "gmail-client-id";
    process.env[gmail.clientSecretEnvKey!] = "gmail-client-secret";
    stubFetch({
      access_token: "gmail-access-new",
      refresh_token: "gmail-refresh-new",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const before = Date.now();
    const result = await tokens.refreshOAuthAccessToken("gmail");
    const after = Date.now();

    expect(result).toBe("gmail-access-new");

    // The credential file holds long-lived OAuth secrets, so the persistence
    // layer must keep it readable only by the owner (0o600) inside an
    // owner-only directory (0o700). This is the security invariant under test;
    // POSIX mode bits do not exist on Windows, so assert them only there.
    if (isPosix) {
      const dirMode = (await stat(envDirFor(home))).mode & 0o777;
      const fileMode = (await stat(envPathFor(home))).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }

    const persisted = await readPersistedEnv(home);
    expect(persisted[gmail.tokenMapping.accessTokenEnvKey]).toBe(
      "gmail-access-new",
    );
    expect(persisted[gmail.tokenMapping.refreshTokenEnvKey!]).toBe(
      "gmail-refresh-new",
    );
    expect(persisted[gmail.tokenMapping.tokenTypeEnvKey!]).toBe("Bearer");

    // expires_in is seconds-from-now; it must be materialized as an absolute
    // ISO timestamp bounded by when the refresh actually ran.
    const expiresAt = Date.parse(
      persisted[gmail.tokenMapping.expiresAtEnvKey!],
    );
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);
  });

  test("sends client_secret for a client_secret_post provider", async () => {
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    const gmail = getAuthProvider("gmail");

    process.env[gmail.tokenMapping.refreshTokenEnvKey!] = "gmail-refresh";
    process.env[gmail.clientIdEnvKey!] = "gmail-client-id";
    process.env[gmail.clientSecretEnvKey!] = "gmail-client-secret";
    const fetchMock = stubFetch({ access_token: "gmail-access-new" });

    await tokens.refreshOAuthAccessToken("gmail");

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { body: URLSearchParams },
    ];
    const sentBody = init.body.toString();
    expect(sentBody).toContain("grant_type=refresh_token");
    expect(sentBody).toContain("client_secret=gmail-client-secret");
  });

  test("omits client_secret for a public (clientAuth none) provider", async () => {
    // X uses clientAuth "none"; the refresh must authenticate with client_id
    // alone and must never emit a client_secret field.
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    const x = getAuthProvider("x");

    process.env[x.tokenMapping.refreshTokenEnvKey!] = "x-refresh";
    process.env[x.clientIdEnvKey!] = "x-client-id";
    const fetchMock = stubFetch({ access_token: "x-access-new" });

    const result = await tokens.refreshOAuthAccessToken("x");

    expect(result).toBe("x-access-new");
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { body: URLSearchParams },
    ];
    const sentBody = init.body.toString();
    expect(sentBody).toContain("client_id=x-client-id");
    expect(sentBody).not.toContain("client_secret");
  });
});

describe("refreshOAuthAccessToken untrusted-response handling", () => {
  test("rejects a response with no access token", async () => {
    // The token endpoint response is untrusted input; a body missing the one
    // required field must surface as an error, not a silently blank credential.
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    const gmail = getAuthProvider("gmail");

    process.env[gmail.tokenMapping.refreshTokenEnvKey!] = "gmail-refresh";
    process.env[gmail.clientIdEnvKey!] = "gmail-client-id";
    process.env[gmail.clientSecretEnvKey!] = "gmail-client-secret";
    stubFetch({ token_type: "Bearer" });

    await expect(tokens.refreshOAuthAccessToken("gmail")).rejects.toThrow(
      /did not return an access token/u,
    );
  });

  test("rejects a non-string access token", async () => {
    // JSON can carry any type; a numeric access_token must be rejected rather
    // than coerced and persisted.
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    const gmail = getAuthProvider("gmail");

    process.env[gmail.tokenMapping.refreshTokenEnvKey!] = "gmail-refresh";
    process.env[gmail.clientIdEnvKey!] = "gmail-client-id";
    process.env[gmail.clientSecretEnvKey!] = "gmail-client-secret";
    stubFetch({ access_token: 12345 });

    await expect(tokens.refreshOAuthAccessToken("gmail")).rejects.toThrow(
      /did not return an access token/u,
    );
  });

  test("ignores a non-numeric expires_in instead of persisting a bad expiry", async () => {
    // A string expires_in fails the Number.isFinite guard, so no expiry is
    // written; a bogus timestamp must never reach the credential file.
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    const gmail = getAuthProvider("gmail");

    process.env[gmail.tokenMapping.refreshTokenEnvKey!] = "gmail-refresh";
    process.env[gmail.clientIdEnvKey!] = "gmail-client-id";
    process.env[gmail.clientSecretEnvKey!] = "gmail-client-secret";
    stubFetch({ access_token: "gmail-access-new", expires_in: "not-a-number" });

    await tokens.refreshOAuthAccessToken("gmail");

    const persisted = await readPersistedEnv(home);
    expect(persisted[gmail.tokenMapping.accessTokenEnvKey]).toBe(
      "gmail-access-new",
    );
    expect(persisted[gmail.tokenMapping.expiresAtEnvKey!]).toBeUndefined();
  });

  test("only persists optional fields the response actually provides", async () => {
    // A response omitting refresh_token/token_type must not fabricate or blank
    // those keys; only the access token is required.
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    const gmail = getAuthProvider("gmail");

    process.env[gmail.tokenMapping.refreshTokenEnvKey!] = "gmail-refresh";
    process.env[gmail.clientIdEnvKey!] = "gmail-client-id";
    process.env[gmail.clientSecretEnvKey!] = "gmail-client-secret";
    stubFetch({ access_token: "gmail-access-new" });

    await tokens.refreshOAuthAccessToken("gmail");

    const persisted = await readPersistedEnv(home);
    expect(persisted[gmail.tokenMapping.accessTokenEnvKey]).toBe(
      "gmail-access-new",
    );
    expect(persisted[gmail.tokenMapping.refreshTokenEnvKey!]).toBeUndefined();
    expect(persisted[gmail.tokenMapping.tokenTypeEnvKey!]).toBeUndefined();
  });

  test("reads Slack's tokens from the nested authed_user object", async () => {
    // Slack returns the user token under authed_user, not at the top level;
    // getTokenValue's Slack branch must read the nested fields and ignore the
    // decoy top-level access_token.
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    const slack = getAuthProvider("slack");

    process.env[slack.tokenMapping.refreshTokenEnvKey!] = "slack-refresh";
    process.env[slack.clientIdEnvKey!] = "slack-client-id";
    process.env[slack.clientSecretEnvKey!] = "slack-client-secret";
    stubFetch({
      access_token: "top-level-bot-token-ignored",
      authed_user: {
        access_token: "slack-user-token",
        refresh_token: "slack-user-refresh",
        token_type: "Bearer",
      },
    });

    const result = await tokens.refreshOAuthAccessToken("slack");

    expect(result).toBe("slack-user-token");
    const persisted = await readPersistedEnv(home);
    expect(persisted[slack.tokenMapping.accessTokenEnvKey]).toBe(
      "slack-user-token",
    );
    expect(persisted[slack.tokenMapping.refreshTokenEnvKey!]).toBe(
      "slack-user-refresh",
    );
  });

  test("throws on a non-ok token endpoint response", async () => {
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    const gmail = getAuthProvider("gmail");

    process.env[gmail.tokenMapping.refreshTokenEnvKey!] = "gmail-refresh";
    process.env[gmail.clientIdEnvKey!] = "gmail-client-id";
    process.env[gmail.clientSecretEnvKey!] = "gmail-client-secret";
    stubFetch("denied", 400);

    await expect(tokens.refreshOAuthAccessToken("gmail")).rejects.toThrow(
      /token refresh failed: 400/u,
    );
  });
});

describe("refreshOAuthAccessToken precondition failures", () => {
  test("requires a refresh token", async () => {
    // Guard runs before any network use, so fetch must never be reached.
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    const fetchMock = stubFetchNeverCalled();

    await expect(tokens.refreshOAuthAccessToken("gmail")).rejects.toThrow(
      /refresh token is required/u,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("requires a client id", async () => {
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    const gmail = getAuthProvider("gmail");
    process.env[gmail.tokenMapping.refreshTokenEnvKey!] = "gmail-refresh";
    const fetchMock = stubFetchNeverCalled();

    await expect(tokens.refreshOAuthAccessToken("gmail")).rejects.toThrow(
      /client id is required/u,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("requires a client secret for a client_secret_post provider", async () => {
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    const gmail = getAuthProvider("gmail");
    process.env[gmail.tokenMapping.refreshTokenEnvKey!] = "gmail-refresh";
    process.env[gmail.clientIdEnvKey!] = "gmail-client-id";
    const fetchMock = stubFetchNeverCalled();

    await expect(tokens.refreshOAuthAccessToken("gmail")).rejects.toThrow(
      /is required to refresh/u,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getOAuthAccessToken", () => {
  test("returns the cached token without refreshing when still valid", async () => {
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    const gmail = getAuthProvider("gmail");
    process.env[gmail.tokenMapping.accessTokenEnvKey] = "cached-token";
    process.env[gmail.tokenMapping.expiresAtEnvKey!] = new Date(
      Date.now() + 600_000,
    ).toISOString();
    const fetchMock = stubFetchNeverCalled();

    await expect(tokens.getOAuthAccessToken("gmail")).resolves.toBe(
      "cached-token",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refreshes when the cached token is expired", async () => {
    const home = await createTempHome();
    const tokens = await loadTokensModule(home);
    const gmail = getAuthProvider("gmail");
    process.env[gmail.tokenMapping.accessTokenEnvKey] = "stale-token";
    process.env[gmail.tokenMapping.expiresAtEnvKey!] = new Date(
      Date.now() - 1_000,
    ).toISOString();
    process.env[gmail.tokenMapping.refreshTokenEnvKey!] = "gmail-refresh";
    process.env[gmail.clientIdEnvKey!] = "gmail-client-id";
    process.env[gmail.clientSecretEnvKey!] = "gmail-client-secret";
    const fetchMock = stubFetch({ access_token: "fresh-token" });

    await expect(tokens.getOAuthAccessToken("gmail")).resolves.toBe(
      "fresh-token",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
