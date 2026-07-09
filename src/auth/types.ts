export type AuthProviderId = "gmail" | "notion" | "slack" | "x";

export type OAuthClientAuth = "client_secret_post" | "none";

export type OAuthProviderConfig = {
  authUrl?: string;
  clientAuth: OAuthClientAuth;
  clientIdEnvKey?: string;
  clientSecretEnvKey?: string;
  displayName: string;
  extraAuthParams?: Record<string, string>;
  id: AuthProviderId;
  mcpResourceUrl?: string;
  scopes: string[];
  tokenUrl?: string;
  tokenMapping: OAuthTokenMapping;
};

export type OAuthTokenMapping = {
  accessTokenEnvKey: string;
  clientIdEnvKey?: string;
  expiresAtEnvKey?: string;
  refreshTokenEnvKey?: string;
  tokenTypeEnvKey?: string;
};

export type OAuthClientRegistration = {
  authUrl: string;
  clientAuth: OAuthClientAuth;
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
};

export type OAuthRunResult = {
  provider: AuthProviderId;
  savedEnvKeys: string[];
};
