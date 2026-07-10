import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import http from "node:http";
import { AddressInfo } from "node:net";
import { loadOpenWikiEnv, saveOpenWikiEnv } from "../env.js";
import { getAuthProvider } from "./providers.js";
import type {
  AuthProviderId,
  OAuthClientRegistration,
  OAuthProviderConfig,
  OAuthRunResult,
} from "./types.js";

type TokenResponse = {
  access_token?: string;
  authed_user?: {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    token_type?: string;
  };
  expires_in?: number;
  refresh_token?: string;
  token_type?: string;
};

type OAuthMetadata = {
  authorization_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  token_endpoint?: string;
};

type ProtectedResourceMetadata = {
  authorization_servers?: string[];
};

const CALLBACK_HOST = "127.0.0.1";
const DEFAULT_CALLBACK_PORT = 53682;
const OAUTH_CALLBACK_PORT_ENV_KEY = "OPENWIKI_OAUTH_CALLBACK_PORT";
const HTTPS_OAUTH_REDIRECT_URI_ENV_KEY = "OPENWIKI_HTTPS_OAUTH_REDIRECT_URI";

export type OAuthAuthOptions = {
  onAuthorizationUrl?: (event: {
    copiedToClipboard: boolean;
    openedBrowser: boolean;
    provider: AuthProviderId;
    url: string;
  }) => void;
  silent?: boolean;
};

export async function runOAuthAuth(
  providerId: AuthProviderId,
  options: OAuthAuthOptions = {},
): Promise<OAuthRunResult> {
  await loadOpenWikiEnv();
  const provider = getAuthProvider(providerId);
  const callback = await createCallbackServer(provider);
  const state = createRandomUrlToken();
  const codeVerifier = createRandomUrlToken(64);
  const codeChallenge = createCodeChallenge(codeVerifier);

  try {
    const registration = await resolveClientRegistration(
      provider,
      callback.redirectUri,
    );
    const authUrl = createAuthorizationUrl(
      provider,
      registration,
      callback.redirectUri,
      state,
      codeChallenge,
    );

    const openedBrowser = await openBrowser(authUrl);
    const copiedToClipboard = await copyToClipboard(authUrl);
    options.onAuthorizationUrl?.({
      copiedToClipboard,
      openedBrowser,
      provider: provider.id,
      url: authUrl,
    });
    if (options.silent !== true) {
      process.stdout.write(
        openedBrowser
          ? `Opened browser for ${provider.displayName} authorization. Waiting for callback...\n`
          : `Open this URL to authorize ${provider.displayName}:\n${authUrl}\nWaiting for callback...\n`,
      );
    }

    const code = await callback.waitForCode(state);
    const tokenResponse = await exchangeAuthorizationCode({
      code,
      codeVerifier,
      provider,
      redirectUri: callback.redirectUri,
      registration,
    });
    const updates = mapTokenResponse(provider, registration, tokenResponse);
    await saveOpenWikiEnv(updates);

    return {
      provider: provider.id,
      savedEnvKeys: Object.keys(updates),
    };
  } finally {
    await callback.close();
  }
}

export function formatAuthProviderList(): string {
  return [
    "Available auth providers:",
    "  slack   Slack OAuth user token for user-visible conversations",
    "  gmail   Gmail read-only OAuth token",
    "  x       X/Twitter OAuth token for timelines, lists, and bookmarks",
    "  notion  Notion hosted MCP OAuth using dynamic client registration",
    "",
    "Run OAuth, create connector config, and discover MCP tools when available:",
    "  openwiki auth <provider>",
    "",
    "Advanced/retry commands:",
    "  openwiki auth configure <provider>",
    "  openwiki auth tools <provider>",
  ].join("\n");
}

async function resolveClientRegistration(
  provider: OAuthProviderConfig,
  redirectUri: string,
): Promise<OAuthClientRegistration> {
  if (provider.mcpResourceUrl) {
    return registerMcpOAuthClient(provider, redirectUri);
  }

  if (!provider.authUrl || !provider.tokenUrl || !provider.clientIdEnvKey) {
    throw new Error(`${provider.displayName} OAuth provider is incomplete.`);
  }

  const clientId = getRequiredEnv(provider.clientIdEnvKey);
  const clientSecret = provider.clientSecretEnvKey
    ? process.env[provider.clientSecretEnvKey]
    : undefined;

  if (provider.clientAuth === "client_secret_post" && !clientSecret) {
    throw new Error(`${provider.clientSecretEnvKey} is required for auth.`);
  }

  return {
    authUrl: provider.authUrl,
    clientAuth: provider.clientAuth,
    clientId,
    clientSecret,
    tokenUrl: provider.tokenUrl,
  };
}

async function registerMcpOAuthClient(
  provider: OAuthProviderConfig,
  redirectUri: string,
): Promise<OAuthClientRegistration> {
  if (!provider.mcpResourceUrl) {
    throw new Error("MCP OAuth provider requires a resource URL.");
  }

  const protectedMetadata = await discoverProtectedResourceMetadata(
    provider.mcpResourceUrl,
  );
  const authServer = protectedMetadata.authorization_servers?.[0];

  if (!authServer) {
    throw new Error(
      `${provider.displayName} did not advertise an authorization server.`,
    );
  }

  const authMetadata = await discoverAuthorizationServerMetadata(authServer);

  if (
    !authMetadata.authorization_endpoint ||
    !authMetadata.token_endpoint ||
    !authMetadata.registration_endpoint
  ) {
    throw new Error(
      `${provider.displayName} OAuth discovery did not return required endpoints.`,
    );
  }

  const registrationResponse = await fetch(authMetadata.registration_endpoint, {
    body: JSON.stringify({
      client_name: "OpenWiki",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [redirectUri],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!registrationResponse.ok) {
    throw new Error(
      `${provider.displayName} dynamic client registration failed: ${registrationResponse.status}`,
    );
  }

  const registration = (await registrationResponse.json()) as {
    client_id?: string;
  };

  if (!registration.client_id) {
    throw new Error(
      `${provider.displayName} dynamic client registration did not return a client_id.`,
    );
  }

  return {
    authUrl: authMetadata.authorization_endpoint,
    clientAuth: "none",
    clientId: registration.client_id,
    tokenUrl: authMetadata.token_endpoint,
  };
}

async function discoverProtectedResourceMetadata(
  resourceUrl: string,
): Promise<ProtectedResourceMetadata> {
  const url = new URL(resourceUrl);
  const candidates = [
    `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ];

  for (const candidate of candidates) {
    const response = await fetch(candidate);
    if (response.ok) {
      return (await response.json()) as ProtectedResourceMetadata;
    }
  }

  throw new Error("Could not discover MCP protected resource metadata.");
}

async function discoverAuthorizationServerMetadata(
  issuer: string,
): Promise<OAuthMetadata> {
  const issuerUrl = new URL(issuer);
  const candidates = [
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname}`,
    `${issuerUrl.origin}/.well-known/openid-configuration${issuerUrl.pathname}`,
    `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
    `${issuerUrl.origin}/.well-known/openid-configuration`,
  ];

  for (const candidate of candidates) {
    const response = await fetch(candidate);
    if (response.ok) {
      return (await response.json()) as OAuthMetadata;
    }
  }

  throw new Error("Could not discover OAuth authorization server metadata.");
}

function createAuthorizationUrl(
  provider: OAuthProviderConfig,
  registration: OAuthClientRegistration,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const authUrl = new URL(registration.authUrl);
  authUrl.searchParams.set("client_id", registration.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  if (provider.scopes.length > 0) {
    authUrl.searchParams.set("scope", provider.scopes.join(" "));
  }

  for (const [key, value] of Object.entries(provider.extraAuthParams ?? {})) {
    if (value.length > 0) {
      authUrl.searchParams.set(key, value);
    }
  }

  if (provider.mcpResourceUrl) {
    authUrl.searchParams.set("resource", provider.mcpResourceUrl);
  }

  return authUrl.toString();
}

async function exchangeAuthorizationCode({
  code,
  codeVerifier,
  provider,
  redirectUri,
  registration,
}: {
  code: string;
  codeVerifier: string;
  provider: OAuthProviderConfig;
  redirectUri: string;
  registration: OAuthClientRegistration;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: registration.clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  if (registration.clientAuth === "client_secret_post") {
    body.set("client_secret", registration.clientSecret ?? "");
  }

  if (provider.mcpResourceUrl) {
    body.set("resource", provider.mcpResourceUrl);
  }

  const response = await fetch(registration.tokenUrl, {
    body,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      `${provider.displayName} token exchange failed: ${response.status}`,
    );
  }

  return (await response.json()) as TokenResponse;
}

function mapTokenResponse(
  provider: OAuthProviderConfig,
  registration: OAuthClientRegistration,
  tokenResponse: TokenResponse,
): Record<string, string> {
  const accessToken =
    provider.id === "slack"
      ? tokenResponse.authed_user?.access_token
      : tokenResponse.access_token;
  const refreshToken =
    provider.id === "slack"
      ? tokenResponse.authed_user?.refresh_token
      : tokenResponse.refresh_token;
  const expiresIn =
    provider.id === "slack"
      ? tokenResponse.authed_user?.expires_in
      : tokenResponse.expires_in;
  const tokenType =
    provider.id === "slack"
      ? tokenResponse.authed_user?.token_type
      : tokenResponse.token_type;

  if (!accessToken) {
    throw new Error(`${provider.displayName} did not return an access token.`);
  }

  const updates: Record<string, string> = {
    [provider.tokenMapping.accessTokenEnvKey]: accessToken,
  };

  if (refreshToken && provider.tokenMapping.refreshTokenEnvKey) {
    updates[provider.tokenMapping.refreshTokenEnvKey] = refreshToken;
  }

  if (tokenType && provider.tokenMapping.tokenTypeEnvKey) {
    updates[provider.tokenMapping.tokenTypeEnvKey] = tokenType;
  }

  if (expiresIn && provider.tokenMapping.expiresAtEnvKey) {
    updates[provider.tokenMapping.expiresAtEnvKey] = new Date(
      Date.now() + expiresIn * 1000,
    ).toISOString();
  }

  if (provider.tokenMapping.clientIdEnvKey) {
    updates[provider.tokenMapping.clientIdEnvKey] = registration.clientId;
  }

  return updates;
}

async function createCallbackServer(provider: OAuthProviderConfig): Promise<{
  close: () => Promise<void>;
  redirectUri: string;
  waitForCode: (expectedState: string) => Promise<string>;
}> {
  const callbackPort = getCallbackPort();
  let resolveCode: ((code: string) => void) | null = null;
  let rejectCode: ((error: Error) => void) | null = null;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${CALLBACK_HOST}:${(server.address() as AddressInfo).port}`,
    );
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    const error = requestUrl.searchParams.get("error");

    if (error) {
      response.writeHead(400, getCallbackResponseHeaders());
      response.end("OpenWiki authorization failed. You can close this tab.");
      rejectCode?.(new Error(`OAuth provider returned error: ${error}`));
      return;
    }

    if (!code || !state) {
      response.writeHead(400, getCallbackResponseHeaders());
      response.end(
        "OpenWiki authorization callback was missing required data.",
      );
      rejectCode?.(new Error("OAuth callback was missing code or state."));
      return;
    }

    response.writeHead(200, getCallbackResponseHeaders());
    response.end("OpenWiki authorization complete. You can close this tab.");
    resolveCode?.(`${state}:${code}`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(callbackPort, CALLBACK_HOST, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start OAuth callback server.");
  }
  const localRedirectUri = `http://${CALLBACK_HOST}:${address.port}/callback`;

  return {
    close: () => closeCallbackServer(server),
    redirectUri: getProviderRedirectUri(provider, localRedirectUri),
    waitForCode: async (expectedState: string) => {
      const stateAndCode = await codePromise;
      const separatorIndex = stateAndCode.indexOf(":");
      const state = stateAndCode.slice(0, separatorIndex);
      const code = stateAndCode.slice(separatorIndex + 1);

      if (state !== expectedState) {
        throw new Error("OAuth callback state did not match.");
      }

      return code;
    },
  };
}

function getCallbackResponseHeaders(): Record<string, string> {
  return {
    Connection: "close",
    "Content-Type": "text/plain",
  };
}

function closeCallbackServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let completed = false;
    const forceCloseTimer = setTimeout(() => {
      if (!completed) {
        server.closeAllConnections?.();
      }
    }, 1000);

    server.close((error) => {
      completed = true;
      clearTimeout(forceCloseTimer);

      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
    server.closeIdleConnections?.();
  });
}

function getCallbackPort(): number {
  const rawPort = process.env[OAUTH_CALLBACK_PORT_ENV_KEY];
  if (!rawPort) {
    return DEFAULT_CALLBACK_PORT;
  }

  if (!/^[0-9]{1,5}$/u.test(rawPort)) {
    throw new Error(`${OAUTH_CALLBACK_PORT_ENV_KEY} must be a TCP port.`);
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `${OAUTH_CALLBACK_PORT_ENV_KEY} must be between 1024 and 65535.`,
    );
  }

  return port;
}

function getProviderRedirectUri(
  provider: OAuthProviderConfig,
  localRedirectUri: string,
): string {
  const override = process.env[HTTPS_OAUTH_REDIRECT_URI_ENV_KEY];
  if (!providerUsesHttpsRedirectOverride(provider)) {
    return localRedirectUri;
  }

  if (!override) {
    return localRedirectUri;
  }

  const url = new URL(override);

  if (url.pathname !== "/callback") {
    throw new Error(
      `${HTTPS_OAUTH_REDIRECT_URI_ENV_KEY} must end with /callback.`,
    );
  }

  if (url.username || url.password || url.hash) {
    throw new Error(
      `${HTTPS_OAUTH_REDIRECT_URI_ENV_KEY} must not include credentials or a fragment.`,
    );
  }

  if (url.protocol !== "https:") {
    throw new Error(`${HTTPS_OAUTH_REDIRECT_URI_ENV_KEY} must use https.`);
  }

  return url.toString();
}

function providerUsesHttpsRedirectOverride(
  provider: OAuthProviderConfig,
): boolean {
  return provider.id === "slack";
}

async function openBrowser(url: string): Promise<boolean> {
  const platform = process.platform;

  try {
    if (platform === "darwin") {
      await execFilePromise("open", [url]);
      return true;
    }

    if (platform === "win32") {
      await execFilePromise("cmd", ["/c", "start", "", url]);
      return true;
    }

    await execFilePromise("xdg-open", [url]);
    return true;
  } catch {
    return false;
  }
}

async function copyToClipboard(value: string): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }

  try {
    await execFilePromise("pbcopy", [], value);
    return true;
  } catch {
    return false;
  }
}

function execFilePromise(
  command: string,
  args: string[],
  input?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const childProcess = execFile(command, args, (error) => {
      if (error) {
        reject(new Error(error.message, { cause: error }));
        return;
      }

      resolve();
    });

    if (input !== undefined) {
      childProcess.stdin?.end(input);
    }
  });
}

function createRandomUrlToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

function createCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function getRequiredEnv(key: string): string {
  const value = process.env[key];

  if (!value) {
    throw new Error(`${key} is required for auth.`);
  }

  return value;
}
