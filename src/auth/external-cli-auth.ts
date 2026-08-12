import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderExternalCliAuthAdapter,
  providerUsesExternalCliAuth,
  type ExternalCliAuthAdapter,
  type OpenWikiProvider,
} from "../config/constants.js";

const execFileAsync = promisify(execFile);
const EXTERNAL_CLI_TIMEOUT_MS = 5_000;

type ExternalCliAuthAdapterConfig = {
  credentialDescription: string;
  installHint: string;
  loginCommand: string;
  name: string;
  command: string;
  commandArgs: readonly string[];
  tokenArgs: readonly string[];
};

/**
 * `gh`'s `--hostname` flag must match the tenant a provider's base URL
 * actually points at (e.g. a GHE.com data-residency host), or the reused
 * session silently authenticates against the wrong GitHub instance. Falls
 * back to github.com when no override is configured.
 */
function resolveGithubCliHostname(
  provider: OpenWikiProvider,
  env: NodeJS.ProcessEnv,
): string {
  const baseUrlEnvKey = getProviderBaseUrlEnvKey(provider);
  const override = baseUrlEnvKey ? env[baseUrlEnvKey]?.trim() : undefined;

  if (!override) {
    return "github.com";
  }

  try {
    return new URL(override).hostname;
  } catch {
    return "github.com";
  }
}

function buildExternalCliAuthAdapters(
  provider: OpenWikiProvider,
  env: NodeJS.ProcessEnv,
): Record<ExternalCliAuthAdapter, ExternalCliAuthAdapterConfig> {
  const githubHostname = resolveGithubCliHostname(provider, env);

  return {
    "github-cli": {
      command: "gh",
      commandArgs: ["auth", "login", "--hostname", githubHostname],
      credentialDescription: "GitHub CLI session",
      installHint:
        "Install the GitHub CLI (https://cli.github.com), then run `gh auth login`.",
      loginCommand: "gh auth login",
      name: "GitHub CLI",
      tokenArgs: ["auth", "token", "--hostname", githubHostname],
    },
  };
}

export type ExternalCliAuthState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "detected" }
  | { kind: "not-detected"; cliAvailable: boolean }
  | { kind: "logging-in" }
  | { kind: "login-failed" };

export function getExternalCliAuthAdapter(
  provider: OpenWikiProvider,
  env: NodeJS.ProcessEnv = process.env,
): ExternalCliAuthAdapterConfig | null {
  const adapterId = getProviderExternalCliAuthAdapter(provider);

  return adapterId
    ? buildExternalCliAuthAdapters(provider, env)[adapterId]
    : null;
}

export async function isExternalCliAvailable(
  provider: OpenWikiProvider,
): Promise<boolean> {
  const adapter = getExternalCliAuthAdapter(provider);

  if (!adapter) {
    return false;
  }

  try {
    await execFileAsync(adapter.command, ["--version"], {
      timeout: EXTERNAL_CLI_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export async function detectExternalCliCredential(
  provider: OpenWikiProvider,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const adapter = getExternalCliAuthAdapter(provider, env);

  if (!adapter) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(adapter.command, adapter.tokenArgs, {
      timeout: EXTERNAL_CLI_TIMEOUT_MS,
    });
    const credential = stdout.trim();

    return credential.length > 0 ? credential : null;
  } catch {
    return null;
  }
}

/**
 * Reuse an external CLI credential for this process only. The CLI remains the
 * source of truth, so its token is deliberately never written to OpenWiki's
 * env file.
 */
export async function resolveExternalCliCredential(
  provider: OpenWikiProvider,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!providerUsesExternalCliAuth(provider)) {
    return false;
  }

  const envKey = getProviderApiKeyEnvKey(provider);

  if (!envKey || env[envKey]?.trim()) {
    return false;
  }

  const credential = await detectExternalCliCredential(provider, env);

  if (!credential) {
    return false;
  }

  env[envKey] = credential;
  return true;
}

export function runExternalCliLogin(
  provider: OpenWikiProvider,
): Promise<boolean> {
  const adapter = getExternalCliAuthAdapter(provider);

  if (!adapter) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const child = spawn(adapter.command, [...adapter.commandArgs], {
      stdio: "inherit",
    });

    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

export function validateExternalCliCredential(
  provider: OpenWikiProvider,
  credential: string,
): void {
  if (
    getProviderExternalCliAuthAdapter(provider) === "github-cli" &&
    /^(ghp_|github_pat_)/u.test(credential)
  ) {
    throw new Error(
      "The GitHub Copilot API does not accept Personal Access Tokens. Authenticate with `gh auth login` using a Copilot-enabled account, or set COPILOT_API_KEY to a GitHub OAuth token.",
    );
  }
}
