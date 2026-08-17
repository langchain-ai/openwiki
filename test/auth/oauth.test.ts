import net from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createCallbackServer,
  formatAuthProviderList,
} from "../../src/auth/oauth.ts";
import { getAuthProvider } from "../../src/auth/providers.ts";

// oauth.ts keeps almost every helper module-private; the exported seams reached
// here are formatAuthProviderList (pure) and createCallbackServer, which routes
// through the private getCallbackPort / getProviderRedirectUri / state-matching
// logic. The port-validation cases throw before the loopback server ever binds,
// so they stay dependency-free; the redirect-uri and callback-handler cases do
// bind a 127.0.0.1 server and are closed in every branch to avoid open handles.

const CALLBACK_PORT_ENV_KEY = "OPENWIKI_OAUTH_CALLBACK_PORT";
const HTTPS_REDIRECT_ENV_KEY = "OPENWIKI_HTTPS_OAUTH_REDIRECT_URI";

const originalCallbackPort = process.env[CALLBACK_PORT_ENV_KEY];
const originalHttpsRedirect = process.env[HTTPS_REDIRECT_ENV_KEY];

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  delete process.env[CALLBACK_PORT_ENV_KEY];
  delete process.env[HTTPS_REDIRECT_ENV_KEY];
});

afterEach(() => {
  restoreEnv(CALLBACK_PORT_ENV_KEY, originalCallbackPort);
  restoreEnv(HTTPS_REDIRECT_ENV_KEY, originalHttpsRedirect);
});

/**
 * Reserves an ephemeral loopback port and releases it so a callback server can
 * bind it, keeping concurrent test files off the fixed default port.
 */
async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as net.AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
}

describe("formatAuthProviderList", () => {
  test("names every supported provider and the auth commands", () => {
    const listing = formatAuthProviderList();

    // The four provider ids the CLI accepts must all be discoverable here, or
    // `openwiki auth` help silently drops a working integration.
    for (const provider of ["slack", "gmail", "x", "notion"]) {
      expect(listing).toContain(provider);
    }
    expect(listing).toContain("openwiki auth <provider>");
    expect(listing).toContain("openwiki auth configure <provider>");
    expect(listing).toContain("openwiki auth tools <provider>");
  });
});

describe("createCallbackServer port validation", () => {
  // A malformed OPENWIKI_OAUTH_CALLBACK_PORT is rejected before the server
  // binds, so an operator typo fails loudly instead of listening somewhere
  // unexpected.
  test("rejects a non-numeric callback port before binding", async () => {
    process.env[CALLBACK_PORT_ENV_KEY] = "not-a-port";

    await expect(
      createCallbackServer(getAuthProvider("gmail")),
    ).rejects.toThrow(`${CALLBACK_PORT_ENV_KEY} must be a TCP port.`);
  });

  test("rejects an over-long numeric string that cannot be a TCP port", async () => {
    // Six digits fail the 1-5 digit shape check outright.
    process.env[CALLBACK_PORT_ENV_KEY] = "999999";

    await expect(
      createCallbackServer(getAuthProvider("gmail")),
    ).rejects.toThrow(`${CALLBACK_PORT_ENV_KEY} must be a TCP port.`);
  });

  test("rejects a privileged port below the unprivileged range", async () => {
    process.env[CALLBACK_PORT_ENV_KEY] = "80";

    await expect(
      createCallbackServer(getAuthProvider("gmail")),
    ).rejects.toThrow(
      `${CALLBACK_PORT_ENV_KEY} must be between 1024 and 65535.`,
    );
  });

  test("rejects a five-digit port above the TCP maximum", async () => {
    // Passes the digit-shape check but exceeds 65535, so the range guard trips.
    process.env[CALLBACK_PORT_ENV_KEY] = "70000";

    await expect(
      createCallbackServer(getAuthProvider("gmail")),
    ).rejects.toThrow(
      `${CALLBACK_PORT_ENV_KEY} must be between 1024 and 65535.`,
    );
  });
});

describe("createCallbackServer redirect uri", () => {
  test("uses the loopback callback url for a non-override provider", async () => {
    const port = await findFreePort();
    process.env[CALLBACK_PORT_ENV_KEY] = String(port);
    const callback = await createCallbackServer(getAuthProvider("gmail"));

    try {
      expect(callback.redirectUri).toBe(`http://127.0.0.1:${port}/callback`);
    } finally {
      await callback.close();
    }
  });

  test("ignores an https override for a provider that does not opt into it", async () => {
    const port = await findFreePort();
    process.env[CALLBACK_PORT_ENV_KEY] = String(port);
    // Only Slack consumes the https redirect override; Gmail must keep loopback
    // even when the env var is present, so a stray override cannot redirect the
    // Gmail flow off-box.
    process.env[HTTPS_REDIRECT_ENV_KEY] = "https://example.ngrok.app/callback";
    const callback = await createCallbackServer(getAuthProvider("gmail"));

    try {
      expect(callback.redirectUri).toBe(`http://127.0.0.1:${port}/callback`);
    } finally {
      await callback.close();
    }
  });

  test("keeps loopback for slack when no override is configured", async () => {
    const port = await findFreePort();
    process.env[CALLBACK_PORT_ENV_KEY] = String(port);
    const callback = await createCallbackServer(getAuthProvider("slack"));

    try {
      expect(callback.redirectUri).toBe(`http://127.0.0.1:${port}/callback`);
    } finally {
      await callback.close();
    }
  });

  test("adopts a valid https override for slack", async () => {
    const port = await findFreePort();
    process.env[CALLBACK_PORT_ENV_KEY] = String(port);
    process.env[HTTPS_REDIRECT_ENV_KEY] = "https://tunnel.ngrok.app/callback";
    const callback = await createCallbackServer(getAuthProvider("slack"));

    try {
      expect(callback.redirectUri).toBe("https://tunnel.ngrok.app/callback");
    } finally {
      await callback.close();
    }
  });
});

describe("createCallbackServer callback handling", () => {
  test("captures the authorization code when the state matches", async () => {
    const port = await findFreePort();
    process.env[CALLBACK_PORT_ENV_KEY] = String(port);
    const callback = await createCallbackServer(getAuthProvider("gmail"));

    try {
      const codePromise = callback.waitForCode("state-123");
      const response = await fetch(
        `http://127.0.0.1:${port}/callback?code=auth-code&state=state-123`,
      );

      expect(response.status).toBe(200);
      await expect(codePromise).resolves.toBe("auth-code");
    } finally {
      await callback.close();
    }
  });

  test("rejects a callback whose state does not match the request", async () => {
    const port = await findFreePort();
    process.env[CALLBACK_PORT_ENV_KEY] = String(port);
    const callback = await createCallbackServer(getAuthProvider("gmail"));

    try {
      // A mismatched state is the CSRF signal: the redirect did not originate
      // from the authorization request this process started, so the code must
      // never be accepted. The rejection handler is attached before the fetch
      // so the pending rejection is never momentarily unhandled.
      const assertion = expect(
        callback.waitForCode("expected-state"),
      ).rejects.toThrow("OAuth callback state did not match.");
      await fetch(
        `http://127.0.0.1:${port}/callback?code=auth-code&state=attacker-state`,
      );

      await assertion;
    } finally {
      await callback.close();
    }
  });

  test("surfaces a provider error and answers with a 400", async () => {
    const port = await findFreePort();
    process.env[CALLBACK_PORT_ENV_KEY] = String(port);
    const callback = await createCallbackServer(getAuthProvider("gmail"));

    try {
      const assertion = expect(
        callback.waitForCode("state-123"),
      ).rejects.toThrow("OAuth provider returned error: access_denied");
      const response = await fetch(
        `http://127.0.0.1:${port}/callback?error=access_denied`,
      );

      expect(response.status).toBe(400);
      await assertion;
    } finally {
      await callback.close();
    }
  });

  test("rejects a callback that is missing the code or state", async () => {
    const port = await findFreePort();
    process.env[CALLBACK_PORT_ENV_KEY] = String(port);
    const callback = await createCallbackServer(getAuthProvider("gmail"));

    try {
      const assertion = expect(
        callback.waitForCode("state-123"),
      ).rejects.toThrow("OAuth callback was missing code or state.");
      const response = await fetch(`http://127.0.0.1:${port}/callback`);

      expect(response.status).toBe(400);
      await assertion;
    } finally {
      await callback.close();
    }
  });
});
