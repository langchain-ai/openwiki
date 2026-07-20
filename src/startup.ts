import { shouldCheckUpdateNoop, getUpdateNoopStatus } from "./agent/utils.js";
import { readCodexTokensFromEnv } from "./agent/openai-chatgpt-oauth.js";
import type { CliCommand } from "./commands.js";
import {
  OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY,
  OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY,
  OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY,
  getMissingProviderEnvKey,
  getProviderApiKeyEnvKey,
  getProviderCredentialHint,
  providerUsesOAuth,
  resolveConfiguredProvider,
  type OpenWikiProvider,
} from "./constants.js";

type ResolveStartupCommandOptions = {
  cwd?: string;
  isStdinTTY?: boolean;
};

export async function resolveStartupCommand(
  command: CliCommand,
  options: ResolveStartupCommandOptions = {},
): Promise<CliCommand> {
  const isStdinTTY = options.isStdinTTY ?? Boolean(process.stdin.isTTY);

  if (
    command.kind === "run" &&
    !command.dryRun &&
    !command.shouldStart &&
    !isStdinTTY
  ) {
    return {
      kind: "error",
      exitCode: 1,
      message:
        "Interactive chat requires a terminal. Pass a message or use --init or --update for non-interactive runs.",
    };
  }

  if (
    command.kind === "run" &&
    !command.dryRun &&
    command.shouldStart &&
    (command.print || !isStdinTTY)
  ) {
    const provider = resolveConfiguredProvider();
    const missingEnvKey = getMissingNonInteractiveProviderEnvKey(
      provider,
      process.env,
    );

    if (missingEnvKey) {
      if (
        command.print &&
        (await canSkipCleanUpdateBeforeCredentials(
          command,
          options.cwd ?? process.cwd(),
        ))
      ) {
        return command;
      }

      const hint = getProviderCredentialHint(provider);

      return {
        kind: "error",
        exitCode: 1,
        message: `${formatCredentialRequirement(provider, missingEnvKey)} is required for non-interactive runs. Run openwiki in an interactive terminal to save credentials.${
          hint ? ` ${hint}` : ""
        }`,
      };
    }
  }

  if (
    command.kind === "run" &&
    !command.dryRun &&
    command.userMessage !== null &&
    command.userMessage.trim().length === 0
  ) {
    return {
      kind: "error",
      exitCode: 1,
      message: "User message cannot be empty.",
    };
  }

  return command;
}

function getMissingNonInteractiveProviderEnvKey(
  provider: OpenWikiProvider,
  env: NodeJS.ProcessEnv,
): string | null {
  if (!providerUsesOAuth(provider)) {
    return getMissingProviderEnvKey(provider, env);
  }

  return readCodexTokensFromEnv(env) === null
    ? (getProviderApiKeyEnvKey(provider) ?? "ChatGPT OAuth token set")
    : null;
}

function formatCredentialRequirement(
  provider: OpenWikiProvider,
  apiKeyEnvKey: string,
): string {
  if (!providerUsesOAuth(provider)) {
    return apiKeyEnvKey;
  }

  return `A complete ChatGPT OAuth token set (${apiKeyEnvKey}, ${OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY}, ${OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY}, ${OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY})`;
}

async function canSkipCleanUpdateBeforeCredentials(
  command: Extract<CliCommand, { kind: "run" }>,
  cwd: string,
): Promise<boolean> {
  if (
    command.command !== "update" ||
    command.userMessage !== null ||
    !shouldCheckUpdateNoop({ userMessage: command.userMessage })
  ) {
    return false;
  }

  try {
    const noopStatus = await getUpdateNoopStatus(cwd);

    return noopStatus.shouldSkip;
  } catch {
    return false;
  }
}
