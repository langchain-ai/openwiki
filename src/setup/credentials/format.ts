import { spawn } from "node:child_process";
import {
  getMissingProviderEnvKey,
  getProviderApiKeyEnvKey,
  getProviderSecretKeyEnvKey,
  providerUsesAwsSdkCredentials,
  providerUsesOAuth,
  AWS_ACCESS_KEY_ID_ENV_KEY,
  AWS_SECRET_ACCESS_KEY_ENV_KEY,
  AWS_SESSION_TOKEN_ENV_KEY,
  AWS_BEARER_TOKEN_BEDROCK_ENV_KEY,
  BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY,
  BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY,
  OPENAI_CHATGPT_EMAIL_ENV_KEY,
  OPENAI_CHATGPT_PLAN_ENV_KEY,
  type OpenWikiProvider,
} from "../../config/constants.js";
import { openWikiEnvPath } from "../../config/env.js";
import {
  formatChatGptAccount,
  type CodexTokens,
} from "../../agent/openai-chatgpt-oauth.js";
import type { AuthProviderId } from "../../auth/types.js";
import { isCredentialConfigured } from "./steps.js";

export function getAwsCredentialRepairMessage(
  provider: OpenWikiProvider,
): string | null {
  if (!providerUsesAwsSdkCredentials(provider)) {
    return null;
  }

  const missingEnvKey = getMissingProviderEnvKey(provider);

  if (!missingEnvKey) {
    return null;
  }

  const pair =
    missingEnvKey === BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY ||
    missingEnvKey === BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY
      ? `${BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY} and ${BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY}`
      : `${AWS_ACCESS_KEY_ID_ENV_KEY} and ${AWS_SECRET_ACCESS_KEY_ENV_KEY}`;

  return `${missingEnvKey} is missing or blank. Set both ${pair}, or unset both in your shell and ${openWikiEnvPath}, then restart OpenWiki.`;
}

export function getCredentialSetupDetail(
  provider: OpenWikiProvider,
  tokens: CodexTokens | null = null,
): string {
  if (providerUsesOAuth(provider)) {
    if (!isCredentialConfigured(provider) && !tokens) {
      return "sign in with your ChatGPT account";
    }

    const account = formatChatGptAccount(
      tokens?.email ?? process.env[OPENAI_CHATGPT_EMAIL_ENV_KEY] ?? null,
      tokens?.planType ?? process.env[OPENAI_CHATGPT_PLAN_ENV_KEY] ?? null,
    );

    return account ? `signed in as ${account}` : "signed in with ChatGPT";
  }

  if (providerUsesAwsSdkCredentials(provider)) {
    if (process.env[AWS_BEARER_TOKEN_BEDROCK_ENV_KEY]?.trim()) {
      return "Bedrock bearer token (takes precedence)";
    }

    const missingEnvKey = getMissingProviderEnvKey(provider);

    if (missingEnvKey) {
      if (
        missingEnvKey === BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY ||
        missingEnvKey === BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY
      ) {
        return "incomplete legacy Bedrock keys; set both or clear both";
      }

      if (
        missingEnvKey === AWS_ACCESS_KEY_ID_ENV_KEY ||
        missingEnvKey === AWS_SECRET_ACCESS_KEY_ENV_KEY
      ) {
        return "incomplete standard AWS credentials; set the full set or unset it";
      }

      return `incomplete AWS credential configuration (${missingEnvKey})`;
    }

    const legacyApiKey = getProviderApiKeyEnvKey(provider);
    const legacySecretKey = getProviderSecretKeyEnvKey(provider);
    const usesLegacyKeys = Boolean(
      legacyApiKey &&
      legacySecretKey &&
      process.env[legacyApiKey]?.trim() &&
      process.env[legacySecretKey]?.trim(),
    );

    const ignoresOrphanSessionToken = Boolean(
      process.env[AWS_SESSION_TOKEN_ENV_KEY]?.trim() &&
      !process.env[AWS_ACCESS_KEY_ID_ENV_KEY]?.trim() &&
      !process.env[AWS_SECRET_ACCESS_KEY_ENV_KEY]?.trim(),
    );

    return usesLegacyKeys
      ? "legacy Bedrock keys (take precedence)"
      : ignoresOrphanSessionToken
        ? "AWS SDK default credential chain (orphan AWS_SESSION_TOKEN ignored)"
        : "AWS SDK default credential chain";
  }

  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);

  return isCredentialConfigured(provider)
    ? "available from environment"
    : apiKeyEnvKey
      ? `save ${apiKeyEnvKey} to ${openWikiEnvPath}`
      : "configure Google Cloud credentials";
}

/**
 * Copies text to the terminal's clipboard using the OSC 52 escape sequence.
 * This targets the user's local terminal emulator even when OpenWiki runs over
 * SSH, unlike shelling out to a host clipboard utility.
 */
export function copyToClipboard(text: string): void {
  const encoded = Buffer.from(text, "utf8").toString("base64");

  process.stdout.write(`\u001b]52;c;${encoded}\u0007`);
}

export function openLoginUrl(url: string): void {
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", '""', `"${url}"`], {
            detached: true,
            stdio: "ignore",
            windowsVerbatimArguments: true,
          })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
            detached: true,
            stdio: "ignore",
          });

    child.on("error", () => {
      // The URL is also rendered for manual use on headless/SSH machines.
    });
    child.unref();
  } catch {
    // Ignore spawn failures; the URL is still rendered for manual use.
  }
}

export function mask(value: string): string {
  if (value.length === 0) {
    return "";
  }

  return "*".repeat(value.length);
}

export function getOAuthAuthorizationStatusText({
  authProvider,
  copiedToClipboard,
}: {
  authProvider?: AuthProviderId;
  copiedToClipboard: boolean;
}): string {
  if (copiedToClipboard) {
    return "Full URL copied to clipboard. Use the link above if your terminal supports it.";
  }

  const authCommand = authProvider
    ? `openwiki auth ${authProvider}`
    : "openwiki auth <provider>";

  return `Use the terminal link above. If it is not clickable, cancel and run ${authCommand} in a plain terminal.`;
}

export function formatSecretInputDisplay(value: string): string {
  // Empty renders as nothing (just the cursor); dots for the entered length,
  // matching the non-secret inputs rather than printing a literal "empty".
  return "•".repeat(value.length);
}

export function formatTerminalHyperlink(url: string, label: string): string {
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

export function getSingleLineInputDisplayValue(
  value: string,
  maxLength: number,
): string {
  if (maxLength <= 0) {
    return "";
  }

  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(-maxLength);
  }

  return `...${value.slice(-(maxLength - 3))}`;
}
