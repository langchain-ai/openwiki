import { loadOpenWikiEnv, saveOpenWikiEnv } from "../env.js";
import { getAuthProvider } from "./providers.js";
import type {
  AuthProviderId,
  OAuthProviderConfig,
  OAuthTokenMapping,
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

type TokenEndpointMetadata = {
  token_endpoint?: string;
};

type TokenResponseField =
  "access_token" | "expires_in" | "refresh_token" | "token_type";

type ProtectedResourceMetadata = {
  authorization_servers?: string[];
};

const REFRESH_EXPIRY_SKEW_MS = 60_000;

export async function getOAuthAccessToken(
  providerId: AuthProviderId,
): Promise<string> {
  await loadOpenWikiEnv();

  const provider = getAuthProvider(providerId);
  const accessToken = process.env[provider.tokenMapping.accessTokenEnvKey];

  if (accessToken && !isOAuthAccessTokenExpired(providerId)) {
    return accessToken;
  }

  return await refreshOAuthAccessToken(providerId);
}

export async function refreshOAuthAccessToken(
  providerId: AuthProviderId,
): Promise<string> {
  await loadOpenWikiEnv();

  const provider = getAuthProvider(providerId);
  const refreshTokenEnvKey = provider.tokenMapping.refreshTokenEnvKey;
  const refreshToken = refreshTokenEnvKey
    ? process.env[refreshTokenEnvKey]
    : undefined;
  const clientId = getProviderClientId(provider);
  const clientSecret = provider.clientSecretEnvKey
    ? process.env[provider.clientSecretEnvKey]
    : undefined;

  if (!refreshTokenEnvKey || !refreshToken) {
    throw new Error(
      `${provider.displayName} refresh token is required for OAuth refresh.`,
    );
  }

  if (!clientId) {
    throw new Error(
      `${provider.displayName} client id is required for OAuth refresh.`,
    );
  }

  if (provider.clientAuth === "client_secret_post" && !clientSecret) {
    throw new Error(
      `${provider.clientSecretEnvKey} is required to refresh ${provider.displayName} access.`,
    );
  }

  const tokenUrl = await resolveTokenUrl(provider);
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  if (provider.clientAuth === "client_secret_post") {
    body.set("client_secret", clientSecret ?? "");
  }

  if (provider.mcpResourceUrl) {
    body.set("resource", provider.mcpResourceUrl);
  }

  const response = await fetch(tokenUrl, {
    body,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      `${provider.displayName} token refresh failed: ${response.status} ${response.statusText}`,
    );
  }

  const tokenResponse = (await response.json()) as TokenResponse;
  const updates = mapTokenResponse(provider, clientId, tokenResponse);
  await saveOpenWikiEnv(updates);

  return updates[provider.tokenMapping.accessTokenEnvKey];
}

export function isOAuthAccessTokenExpired(providerId: AuthProviderId): boolean {
  const provider = getAuthProvider(providerId);
  const expiresAtEnvKey = provider.tokenMapping.expiresAtEnvKey;
  const expiresAt = expiresAtEnvKey ? process.env[expiresAtEnvKey] : undefined;

  if (!expiresAt) {
    return false;
  }

  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) {
    return true;
  }

  return timestamp <= Date.now() + REFRESH_EXPIRY_SKEW_MS;
}

export function getOAuthProviderIdForAccessTokenEnvKey(
  envKey: string,
): AuthProviderId | null {
  const providerIds: AuthProviderId[] = ["gmail", "notion", "slack", "x"];

  for (const providerId of providerIds) {
    const provider = getAuthProvider(providerId);
    if (provider.tokenMapping.accessTokenEnvKey === envKey) {
      return providerId;
    }
  }

  return null;
}

function mapTokenResponse(
  provider: OAuthProviderConfig,
  clientId: string,
  tokenResponse: TokenResponse,
): Record<string, string> {
  const accessToken = getTokenValue(provider, tokenResponse, "access_token");
  const refreshToken = getTokenValue(provider, tokenResponse, "refresh_token");
  const expiresIn = getTokenValue(provider, tokenResponse, "expires_in");
  const tokenType = getTokenValue(provider, tokenResponse, "token_type");

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error(
      `${provider.displayName} token refresh did not return an access token.`,
    );
  }

  const updates: Record<string, string> = {
    [provider.tokenMapping.accessTokenEnvKey]: accessToken,
  };

  setOptionalTokenUpdate(
    updates,
    provider.tokenMapping,
    "refreshTokenEnvKey",
    typeof refreshToken === "string" ? refreshToken : undefined,
  );
  setOptionalTokenUpdate(
    updates,
    provider.tokenMapping,
    "tokenTypeEnvKey",
    typeof tokenType === "string" ? tokenType : undefined,
  );

  if (
    typeof expiresIn === "number" &&
    Number.isFinite(expiresIn) &&
    provider.tokenMapping.expiresAtEnvKey
  ) {
    updates[provider.tokenMapping.expiresAtEnvKey] = new Date(
      Date.now() + expiresIn * 1000,
    ).toISOString();
  }

  if (provider.tokenMapping.clientIdEnvKey) {
    updates[provider.tokenMapping.clientIdEnvKey] = clientId;
  }

  return updates;
}

function getTokenValue(
  provider: OAuthProviderConfig,
  tokenResponse: TokenResponse,
  key: TokenResponseField,
): string | number | undefined {
  if (provider.id === "slack") {
    return tokenResponse.authed_user?.[key];
  }

  return tokenResponse[key];
}

function setOptionalTokenUpdate(
  updates: Record<string, string>,
  mapping: OAuthTokenMapping,
  key: keyof Pick<OAuthTokenMapping, "refreshTokenEnvKey" | "tokenTypeEnvKey">,
  value: string | undefined,
): void {
  const envKey = mapping[key];
  if (envKey && value) {
    updates[envKey] = value;
  }
}

function getProviderClientId(
  provider: OAuthProviderConfig,
): string | undefined {
  const envKey =
    provider.clientIdEnvKey ?? provider.tokenMapping.clientIdEnvKey;
  return envKey ? process.env[envKey] : undefined;
}

async function resolveTokenUrl(provider: OAuthProviderConfig): Promise<string> {
  if (provider.tokenUrl) {
    return provider.tokenUrl;
  }

  if (provider.mcpResourceUrl) {
    return await discoverMcpTokenEndpoint(provider.mcpResourceUrl);
  }

  throw new Error(`${provider.displayName} OAuth token endpoint is unknown.`);
}

async function discoverMcpTokenEndpoint(resourceUrl: string): Promise<string> {
  const protectedMetadata =
    await discoverProtectedResourceMetadata(resourceUrl);
  const authServer = protectedMetadata.authorization_servers?.[0];

  if (!authServer) {
    throw new Error("MCP OAuth resource did not advertise an auth server.");
  }

  const tokenMetadata = await discoverAuthorizationServerMetadata(authServer);
  if (!tokenMetadata.token_endpoint) {
    throw new Error(
      "MCP OAuth authorization server did not expose token_endpoint.",
    );
  }

  return tokenMetadata.token_endpoint;
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
): Promise<TokenEndpointMetadata> {
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
      return (await response.json()) as TokenEndpointMetadata;
    }
  }

  throw new Error("Could not discover OAuth authorization server metadata.");
}
