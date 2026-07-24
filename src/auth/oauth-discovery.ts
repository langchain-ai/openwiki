import { isIP } from "node:net";

export type OAuthMetadata = {
  authorization_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  token_endpoint?: string;
};

export type ProtectedResourceMetadata = {
  authorization_servers?: string[];
};

export type OAuthEndpointValidationOptions = {
  allowedHosts?: readonly string[];
};

export async function discoverProtectedResourceMetadata(
  resourceUrl: string,
  options: OAuthEndpointValidationOptions = {},
): Promise<ProtectedResourceMetadata> {
  const url = validateOAuthEndpointUrl(
    resourceUrl,
    "MCP protected resource URL",
    options,
  );
  const candidates = [
    `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ];

  for (const candidate of candidates) {
    const response = await fetch(
      validateOAuthEndpointUrl(
        candidate,
        "MCP protected resource metadata",
        options,
      ),
      { redirect: "manual" },
    );
    if (response.ok) {
      return (await response.json()) as ProtectedResourceMetadata;
    }
  }

  throw new Error("Could not discover MCP protected resource metadata.");
}

export async function discoverAuthorizationServerMetadata(
  issuer: string,
  options: OAuthEndpointValidationOptions = {},
): Promise<OAuthMetadata> {
  const issuerUrl = validateOAuthEndpointUrl(
    issuer,
    "OAuth authorization server issuer",
    options,
  );
  const candidates = [
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname}`,
    `${issuerUrl.origin}/.well-known/openid-configuration${issuerUrl.pathname}`,
    `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
    `${issuerUrl.origin}/.well-known/openid-configuration`,
  ];

  for (const candidate of candidates) {
    const response = await fetch(
      validateOAuthEndpointUrl(
        candidate,
        "OAuth authorization server metadata",
        options,
      ),
      { redirect: "manual" },
    );
    if (response.ok) {
      return (await response.json()) as OAuthMetadata;
    }
  }

  throw new Error("Could not discover OAuth authorization server metadata.");
}

export function validateOAuthEndpointUrl(
  value: string,
  label: string,
  options: OAuthEndpointValidationOptions = {},
): URL {
  const url = new URL(value);
  const hostname = normalizeHostname(url.hostname);

  if (url.protocol !== "https:") {
    throw new Error(`${label} must use https.`);
  }

  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials.`);
  }

  if (isBlockedHostname(hostname)) {
    throw new Error(`${label} must not target localhost or private networks.`);
  }

  if (
    options.allowedHosts &&
    options.allowedHosts.length > 0 &&
    !matchesAllowedHost(hostname, options.allowedHosts)
  ) {
    throw new Error(`${label} host is not allowed.`);
  }

  return url;
}

function matchesAllowedHost(
  hostname: string,
  allowedHosts: readonly string[],
): boolean {
  return allowedHosts.some((allowedHost) => {
    const normalizedAllowedHost = normalizeHostname(allowedHost);
    return (
      hostname === normalizedAllowedHost ||
      hostname.endsWith(`.${normalizedAllowedHost}`)
    );
  });
}

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .replace(/\.$/u, "")
    .toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    return isBlockedIpv4(hostname);
  }

  if (ipVersion === 6) {
    return isBlockedIpv6(hostname);
  }

  return false;
}

function isBlockedIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  const [first = 0, second = 0] = parts;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isBlockedIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const ipv4MappedAddress = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);

  return (
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    (ipv4MappedAddress ? isBlockedIpv4(ipv4MappedAddress[1]) : false)
  );
}
