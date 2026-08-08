import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// getProviderRedirectUri validates the Slack https redirect override (used for
// tunnelled callbacks) only after the loopback server has bound but before
// createCallbackServer returns its close handle. On the rejecting branches the
// function throws with no handle to clean up, so a real listener would leak and
// hang the run. node:http is mocked here with a server that never binds a real
// socket, keeping those SSRF-guard branches reachable with zero open handles.
// The full happy-path flow that needs a real callback lives in oauth-run and
// oauth-callback-server; this file targets only the override validation.
vi.mock("node:http", () => {
  function createServer(): unknown {
    return {
      address() {
        return { address: "127.0.0.1", family: "IPv4", port: 54321 };
      },
      close(callback?: (error?: Error) => void) {
        callback?.();
      },
      closeAllConnections() {},
      closeIdleConnections() {},
      listen(_port: number, _host: string, callback?: () => void) {
        callback?.();
        return this;
      },
      once() {
        return this;
      },
    };
  }

  return { default: { createServer } };
});

import { createCallbackServer } from "../../src/auth/oauth.ts";
import { getAuthProvider } from "../../src/auth/providers.ts";

const CALLBACK_PORT_ENV_KEY = "OPENWIKI_OAUTH_CALLBACK_PORT";
const HTTPS_REDIRECT_ENV_KEY = "OPENWIKI_HTTPS_OAUTH_REDIRECT_URI";

const originalCallbackPort = process.env[CALLBACK_PORT_ENV_KEY];
const originalHttpsRedirect = process.env[HTTPS_REDIRECT_ENV_KEY];

beforeEach(() => {
  // A valid port keeps getCallbackPort from throwing first, so each case
  // exercises the override validation rather than the port guard.
  process.env[CALLBACK_PORT_ENV_KEY] = "54321";
  delete process.env[HTTPS_REDIRECT_ENV_KEY];
});

afterEach(() => {
  if (originalCallbackPort === undefined) {
    delete process.env[CALLBACK_PORT_ENV_KEY];
  } else {
    process.env[CALLBACK_PORT_ENV_KEY] = originalCallbackPort;
  }
  if (originalHttpsRedirect === undefined) {
    delete process.env[HTTPS_REDIRECT_ENV_KEY];
  } else {
    process.env[HTTPS_REDIRECT_ENV_KEY] = originalHttpsRedirect;
  }
});

describe("slack https redirect override validation", () => {
  test("rejects an override whose path is not /callback", async () => {
    // A tunnel must terminate on the exact /callback path OpenWiki listens for;
    // any other path would silently drop the redirect off-target.
    process.env[HTTPS_REDIRECT_ENV_KEY] = "https://tunnel.example.com/wrong";

    await expect(
      createCallbackServer(getAuthProvider("slack")),
    ).rejects.toThrow(`${HTTPS_REDIRECT_ENV_KEY} must end with /callback.`);
  });

  test("rejects an override that embeds credentials", async () => {
    // Credentials in the redirect URI would leak into the authorization request
    // and browser history, so a userinfo component is refused.
    process.env[HTTPS_REDIRECT_ENV_KEY] =
      "https://user:pass@tunnel.example.com/callback";

    await expect(
      createCallbackServer(getAuthProvider("slack")),
    ).rejects.toThrow(
      `${HTTPS_REDIRECT_ENV_KEY} must not include credentials or a fragment.`,
    );
  });

  test("rejects an override that carries a fragment", async () => {
    // A fragment is not part of what the authorization server matches, so a
    // stray one signals a malformed override and is refused.
    process.env[HTTPS_REDIRECT_ENV_KEY] =
      "https://tunnel.example.com/callback#frag";

    await expect(
      createCallbackServer(getAuthProvider("slack")),
    ).rejects.toThrow(
      `${HTTPS_REDIRECT_ENV_KEY} must not include credentials or a fragment.`,
    );
  });

  test("rejects a non-https override", async () => {
    // The override exists precisely to keep the redirect on TLS end-to-end, so a
    // plaintext http override defeats its purpose and is refused.
    process.env[HTTPS_REDIRECT_ENV_KEY] = "http://tunnel.example.com/callback";

    await expect(
      createCallbackServer(getAuthProvider("slack")),
    ).rejects.toThrow(`${HTTPS_REDIRECT_ENV_KEY} must use https.`);
  });

  test("adopts a fully valid https override", async () => {
    process.env[HTTPS_REDIRECT_ENV_KEY] = "https://tunnel.example.com/callback";
    const callback = await createCallbackServer(getAuthProvider("slack"));

    try {
      expect(callback.redirectUri).toBe("https://tunnel.example.com/callback");
    } finally {
      await callback.close();
    }
  });
});
