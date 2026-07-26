import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { saveOpenWikiEnv } from "../env.js";

const DEFAULT_CALLBACK_PORT = 53682;
const OAUTH_CALLBACK_PORT_ENV_KEY = "OPENWIKI_OAUTH_CALLBACK_PORT";
const HTTPS_OAUTH_REDIRECT_URI_ENV_KEY = "OPENWIKI_HTTPS_OAUTH_REDIRECT_URI";
const NGROK_API_URL = "http://127.0.0.1:4040/api/tunnels";
const NGROK_DISCOVERY_TIMEOUT_MS = 15_000;
const NGROK_DISCOVERY_POLL_MS = 500;

export type NgrokStartOptions = {
  port?: number;
  url?: string | null;
};

export type NgrokStartResult = {
  baseUrl: string;
  port: number;
  redirectUri: string;
};

export async function startNgrokTunnel({
  port = DEFAULT_CALLBACK_PORT,
  url,
}: NgrokStartOptions): Promise<NgrokStartResult> {
  const validatedPort = validatePort(port);
  const normalized = url ? normalizeNgrokUrl(url) : null;

  await saveOpenWikiEnv(
    normalized
      ? {
          [OAUTH_CALLBACK_PORT_ENV_KEY]: String(validatedPort),
          [HTTPS_OAUTH_REDIRECT_URI_ENV_KEY]: normalized.redirectUri,
        }
      : {
          [OAUTH_CALLBACK_PORT_ENV_KEY]: String(validatedPort),
          [HTTPS_OAUTH_REDIRECT_URI_ENV_KEY]: "",
        },
  );

  if (normalized) {
    process.stdout.write(
      [
        `Saved ${HTTPS_OAUTH_REDIRECT_URI_ENV_KEY}=${normalized.redirectUri}`,
        `Saved ${OAUTH_CALLBACK_PORT_ENV_KEY}=${validatedPort}`,
        `Register this Slack redirect URL: ${normalized.redirectUri}`,
        `Starting ngrok: ngrok http ${validatedPort} --url ${normalized.baseUrl}`,
        "",
      ].join("\n"),
    );
  } else {
    process.stdout.write(
      [
        `Saved ${OAUTH_CALLBACK_PORT_ENV_KEY}=${validatedPort}`,
        `Cleared ${HTTPS_OAUTH_REDIRECT_URI_ENV_KEY}; ngrok will choose the URL.`,
        "Starting ngrok with a random HTTPS forwarding URL.",
        `Starting ngrok: ngrok http ${validatedPort}`,
        "",
      ].join("\n"),
    );
  }

  const ngrokProcess = startNgrokProcess(
    normalized?.baseUrl ?? null,
    validatedPort,
  );
  const ngrokExit = waitForNgrokExit(ngrokProcess);

  if (!normalized) {
    await Promise.race([
      discoverAndSaveRandomNgrokRedirectUri(validatedPort),
      ngrokExit,
    ]);
  }

  await ngrokExit;

  return {
    baseUrl: normalized?.baseUrl ?? "",
    port: validatedPort,
    redirectUri: normalized?.redirectUri ?? "",
  };
}

export function getRedirectUriFromNgrokTunnels(
  value: unknown,
  port: number,
): string | null {
  if (!isObject(value) || !Array.isArray(value.tunnels)) {
    return null;
  }

  const httpsTunnels = value.tunnels
    .map((tunnel) => normalizeNgrokTunnel(tunnel, port))
    .filter((tunnel): tunnel is NormalizedNgrokTunnel => tunnel !== null);

  const matchingTunnel =
    httpsTunnels.find((tunnel) => tunnel.matchesPort) ??
    (httpsTunnels.length === 1 ? httpsTunnels[0] : null);

  return matchingTunnel ? `${matchingTunnel.baseUrl}/callback` : null;
}

function normalizeNgrokUrl(value: string): {
  baseUrl: string;
  redirectUri: string;
} {
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
    ? value
    : `https://${value}`;
  const url = new URL(withScheme);

  if (url.protocol !== "https:") {
    throw new Error("ngrok custom URL must use https.");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "ngrok custom URL must not include credentials, query, or fragment.",
    );
  }

  if (url.port) {
    throw new Error("ngrok custom URL must not include a port.");
  }

  if (
    url.pathname !== "/" &&
    url.pathname !== "" &&
    url.pathname !== "/callback"
  ) {
    throw new Error("ngrok custom URL path must be empty or /callback.");
  }

  validateHostname(url.hostname);
  url.pathname = "";

  const baseUrl = url.toString().replace(/\/$/u, "");

  return {
    baseUrl,
    redirectUri: `${baseUrl}/callback`,
  };
}

function validateHostname(hostname: string): void {
  if (
    hostname.length > 253 ||
    !/^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u.test(
      hostname,
    )
  ) {
    throw new Error("ngrok custom URL must include a valid DNS hostname.");
  }
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("ngrok local port must be between 1024 and 65535.");
  }

  return port;
}

type NormalizedNgrokTunnel = {
  baseUrl: string;
  matchesPort: boolean;
};

function normalizeNgrokTunnel(
  value: unknown,
  port: number,
): NormalizedNgrokTunnel | null {
  if (!isObject(value) || typeof value.public_url !== "string") {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value.public_url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") {
    return null;
  }

  if (url.username || url.password || url.search || url.hash || url.port) {
    return null;
  }

  url.pathname = "";
  const baseUrl = url.toString().replace(/\/$/u, "");
  const addr =
    isObject(value.config) && typeof value.config.addr === "string"
      ? value.config.addr
      : "";

  return {
    baseUrl,
    matchesPort: addrMatchesPort(addr, port),
  };
}

function addrMatchesPort(addr: string, port: number): boolean {
  if (!addr) {
    return false;
  }

  if (addr === String(port) || addr.endsWith(`:${port}`)) {
    return true;
  }

  try {
    const parsed = new URL(addr);
    return parsed.port === String(port);
  } catch {
    return false;
  }
}

async function discoverAndSaveRandomNgrokRedirectUri(
  port: number,
): Promise<void> {
  const redirectUri = await waitForRandomNgrokRedirectUri(port);

  if (!redirectUri) {
    process.stdout.write(
      [
        "Could not discover the random ngrok URL from the local ngrok API.",
        "After ngrok starts, copy the HTTPS forwarding URL, append /callback, register it in Slack, and set OPENWIKI_HTTPS_OAUTH_REDIRECT_URI to that callback URL.",
        "",
      ].join("\n"),
    );
    return;
  }

  await saveOpenWikiEnv({
    [OAUTH_CALLBACK_PORT_ENV_KEY]: String(port),
    [HTTPS_OAUTH_REDIRECT_URI_ENV_KEY]: redirectUri,
  });

  process.stdout.write(
    [
      `Discovered ngrok redirect URL: ${redirectUri}`,
      `Saved ${HTTPS_OAUTH_REDIRECT_URI_ENV_KEY}=${redirectUri}`,
      `Register this Slack redirect URL: ${redirectUri}`,
      "",
    ].join("\n"),
  );
}

async function waitForRandomNgrokRedirectUri(
  port: number,
): Promise<string | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < NGROK_DISCOVERY_TIMEOUT_MS) {
    const redirectUri = await fetchNgrokRedirectUri(port);
    if (redirectUri) {
      return redirectUri;
    }

    await sleep(NGROK_DISCOVERY_POLL_MS);
  }

  return null;
}

async function fetchNgrokRedirectUri(port: number): Promise<string | null> {
  try {
    const response = await fetch(NGROK_API_URL);
    if (!response.ok) {
      return null;
    }

    return getRedirectUriFromNgrokTunnels(await response.json(), port);
  } catch {
    return null;
  }
}

function startNgrokProcess(baseUrl: string | null, port: number): ChildProcess {
  const args = baseUrl
    ? ["http", String(port), "--url", baseUrl]
    : ["http", String(port)];

  return spawn("ngrok", args, {
    shell: false,
    stdio: "inherit",
  });
}

function waitForNgrokExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on("error", (error) => {
      reject(
        new Error(
          error instanceof Error
            ? `Could not start ngrok: ${error.message}`
            : "Could not start ngrok.",
        ),
      );
    });
    child.on("exit", (code, signal) => {
      if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") {
        resolve();
        return;
      }

      reject(new Error(`ngrok exited with code=${code} signal=${signal}.`));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
