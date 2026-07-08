import { spawn } from "node:child_process";
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  DEFAULT_PROVIDER,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderLabel,
  getProviderModelOptions,
  isValidBaseUrl,
  isValidModelId,
  normalizeModelId,
  OPENAI_CHATGPT_EMAIL_ENV_KEY,
  OPENAI_CHATGPT_PLAN_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  type OpenWikiProvider,
  providerRequiresBaseUrl,
  providerUsesOAuth,
  resolveConfiguredProvider,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "./constants.js";
import {
  type ChatGptLoginHandle,
  type CodexTokens,
  codexTokensToEnv,
  formatChatGptAccount,
  isChatGptTokenExpired,
  loginWithChatGPT,
  readCodexTokensFromEnv,
} from "./agent/openai-chatgpt-oauth.js";
import { openWikiEnvPath, saveOpenWikiEnv } from "./env.js";

export type InitSetupResult = {
  modelId: string | null;
  provider: OpenWikiProvider | null;
  savedApiKey: boolean;
  savedBaseUrl: boolean;
  savedLangSmithKey: boolean;
  savedModelId: boolean;
  savedProvider: boolean;
};

type InitSetupProps = {
  modelIdOverride?: string | null;
  onComplete: (result: InitSetupResult) => void;
  onError: (message: string) => void;
};

type PromptStep =
  | "api-key"
  | "base-url"
  | "langsmith"
  | "model"
  | "oauth-login"
  | "provider";

export function needsCredentialSetup(
  modelIdOverride: string | null = null,
): boolean {
  const provider = resolveConfiguredProvider();

  return (
    process.env[OPENWIKI_PROVIDER_ENV_KEY] === undefined ||
    needsCredentialStep(provider) ||
    needsBaseUrlStep(provider) ||
    (modelIdOverride === null &&
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined) ||
    process.env.LANGSMITH_API_KEY === undefined
  );
}

/**
 * Whether the provider still needs its primary credential collected. For
 * `oauth` providers this is a valid, non-expired stored token; for everyone
 * else it is a pasted API key.
 */
function needsCredentialStep(provider: OpenWikiProvider): boolean {
  return providerUsesOAuth(provider)
    ? !hasValidStoredToken()
    : !process.env[getProviderApiKeyEnvKey(provider)];
}

/** The step that collects the provider's primary credential. */
function credentialStep(provider: OpenWikiProvider): PromptStep {
  return providerUsesOAuth(provider) ? "oauth-login" : "api-key";
}

function hasValidStoredToken(env: NodeJS.ProcessEnv = process.env): boolean {
  const tokens = readCodexTokensFromEnv(env);

  return tokens !== null && !isChatGptTokenExpired(tokens.expiresAtMs);
}

function needsBaseUrlStep(provider: OpenWikiProvider): boolean {
  if (!providerRequiresBaseUrl(provider)) {
    return false;
  }

  return !isBaseUrlConfigured(provider);
}

function isBaseUrlConfigured(provider: OpenWikiProvider): boolean {
  const baseUrlEnvKey = getProviderBaseUrlEnvKey(provider);

  return baseUrlEnvKey ? Boolean(process.env[baseUrlEnvKey]) : false;
}

function isCredentialConfigured(provider: OpenWikiProvider): boolean {
  return providerUsesOAuth(provider)
    ? hasValidStoredToken()
    : Boolean(process.env[getProviderApiKeyEnvKey(provider)]);
}

function getCredentialSetupDetail(
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

  return isCredentialConfigured(provider)
    ? "available from environment"
    : `save ${getProviderApiKeyEnvKey(provider)} to ${openWikiEnvPath}`;
}

/**
 * Copies text to the terminal's clipboard using the OSC 52 escape sequence.
 * Unlike shelling out to `pbcopy`/`xclip` (which would target the remote host
 * over SSH), OSC 52 is interpreted by the user's local terminal emulator, so
 * the URL lands on the machine where the browser actually runs. Requires a
 * terminal with OSC 52 support (iTerm2, kitty, WezTerm, tmux with
 * `set-clipboard on`, etc.).
 */
function copyToClipboard(text: string): void {
  const encoded = Buffer.from(text, "utf8").toString("base64");

  process.stdout.write(`\u001b]52;c;${encoded}\u0007`);
}

/**
 * Opens the login URL in the user's default browser. Best-effort: on
 * headless/SSH hosts the URL is also rendered as text for manual use.
 *
 * Windows needs `cmd /c start` rather than a shell, because under `shell: true`
 * cmd treats the `&` separating the auth URL's query params as a command
 * separator and mangles the URL. The empty `""` is `start`'s window-title
 * argument (without it, `start` would consume the quoted URL as the title), and
 * `windowsVerbatimArguments` stops Node from re-quoting what we already quoted.
 */
function openLoginUrl(url: string): void {
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", '""', `"${url}"`], {
            stdio: "ignore",
            detached: true,
            windowsVerbatimArguments: true,
          })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
            stdio: "ignore",
            detached: true,
          });

    child.on("error", () => {
      // No browser available (headless/SSH); the URL is shown as text.
    });
    child.unref();
  } catch {
    // Ignore spawn failures; the URL is still rendered for manual use.
  }
}

export function InitSetup({
  modelIdOverride = null,
  onComplete,
  onError,
}: InitSetupProps) {
  const initialProvider = resolveConfiguredProvider();
  const [step, setStep] = useState<PromptStep | null>(null);
  const [provider, setProvider] = useState<OpenWikiProvider>(initialProvider);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [langSmithKey, setLangSmithKey] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [providerSelectionIndex, setProviderSelectionIndex] = useState(() =>
    getProviderSelectionIndex(initialProvider),
  );
  const [modelSelectionIndex, setModelSelectionIndex] = useState(() =>
    getModelSelectionIndex(
      initialProvider,
      modelIdOverride ??
        process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
        getDefaultModelId(initialProvider),
    ),
  );
  const [isCustomModelInput, setIsCustomModelInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [oauthTokens, setOauthTokens] = useState<CodexTokens | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginAttempt, setLoginAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  // Set when the user (re)selects a provider in the wizard, so the model step
  // is shown again even if a (possibly stale) model id is already stored.
  const [forceModelStep, setForceModelStep] = useState(false);
  const loginHandleRef = useRef<ChatGptLoginHandle | null>(null);

  useEffect(() => {
    const initialStep = getInitialStep(modelIdOverride, initialProvider);

    if (initialStep === null) {
      onComplete({
        modelId:
          modelIdOverride ?? process.env[OPENWIKI_MODEL_ID_ENV_KEY] ?? null,
        provider: initialProvider,
        savedApiKey: false,
        savedBaseUrl: false,
        savedLangSmithKey: false,
        savedModelId: false,
        savedProvider: false,
      });
      return;
    }

    setProvider(initialProvider);
    setProviderSelectionIndex(getProviderSelectionIndex(initialProvider));
    setModelSelectionIndex(
      getModelSelectionIndex(
        initialProvider,
        modelIdOverride ??
          process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
          getDefaultModelId(initialProvider),
      ),
    );
    setIsCustomModelInput(
      initialStep === "model" &&
        shouldStartWithCustomModelInput(initialProvider),
    );
    setStep(initialStep);
  }, [initialProvider, modelIdOverride, onComplete]);

  // Drive the browser OAuth login whenever the wizard enters the oauth-login
  // step (or the user retries after a failure). Runs outside the keypress
  // handler because it awaits a browser round-trip.
  useEffect(() => {
    if (step !== "oauth-login") {
      return;
    }

    let cancelled = false;

    setIsLoggingIn(true);
    setLoginUrl(null);
    setCopied(false);
    setInput("");
    setError(null);
    loginHandleRef.current = null;

    void (async () => {
      try {
        const tokens = await loginWithChatGPT(
          (url) => {
            if (cancelled) {
              return;
            }

            setLoginUrl(url);
            openLoginUrl(url);
          },
          (handle) => {
            if (!cancelled) {
              loginHandleRef.current = handle;
            }
          },
        );

        if (cancelled) {
          return;
        }

        setOauthTokens(tokens);
        setIsLoggingIn(false);

        const nextStep = getNextStepAfterApiKey(
          provider,
          modelIdOverride,
          forceModelStep,
        );

        if (nextStep) {
          setIsCustomModelInput(
            nextStep === "model" && shouldStartWithCustomModelInput(provider),
          );
          setStep(nextStep);
          return;
        }

        await completeSetup({
          nextApiKey: apiKey,
          nextBaseUrl: baseUrl,
          nextLangSmithKey: langSmithKey,
          nextModelId: modelId,
          nextProvider: provider,
          nextOAuthTokens: tokens,
        });
      } catch (loginError) {
        if (cancelled) {
          return;
        }

        setIsLoggingIn(false);
        setError(
          loginError instanceof Error
            ? loginError.message
            : "ChatGPT login failed.",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [step, loginAttempt]);

  useInput((inputValue, key) => {
    if (isSaving || step === null) {
      return;
    }

    if (step === "oauth-login") {
      // With nothing typed yet, `c` copies the URL to the local clipboard (via
      // OSC 52, so it works over SSH). Once the user starts pasting a URL/code,
      // `c` is treated as literal text so it isn't swallowed.
      if (
        input.length === 0 &&
        (inputValue === "c" || inputValue === "C") &&
        !key.ctrl &&
        !key.meta
      ) {
        if (loginUrl) {
          copyToClipboard(loginUrl);
          setCopied(true);
        }

        return;
      }

      if (key.return) {
        const pasted = input.trim();

        if (pasted.length > 0) {
          submitManualLogin(pasted);
        } else if (!isLoggingIn) {
          // Nothing pasted: Enter retries a fresh login attempt.
          setLoginAttempt((attempt) => attempt + 1);
        }

        return;
      }

      if (key.backspace || key.delete) {
        setInput((value) => value.slice(0, -1));
        return;
      }

      const sanitizedInput = sanitizeInputChunk(inputValue);

      if (sanitizedInput && !key.ctrl && !key.meta) {
        setError(null);
        setInput((value) => value + sanitizedInput);
      }

      return;
    }

    if (step === "provider") {
      if (key.upArrow || key.downArrow) {
        setError(null);
        setProviderSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            SELECTABLE_OPENWIKI_PROVIDERS.length,
          ),
        );
        return;
      }

      if (key.return) {
        void submit();
      }

      return;
    }

    if (step === "model" && !isCustomModelInput) {
      if (key.upArrow || key.downArrow) {
        setError(null);
        setModelSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            getModelSelectionOptions(provider).length,
          ),
        );
        return;
      }

      if (key.return) {
        void submit();
      }

      return;
    }

    if (key.return) {
      void submit();
      return;
    }

    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }

    const sanitizedInput = sanitizeInputChunk(inputValue);

    if (sanitizedInput && !key.ctrl && !key.meta) {
      setInput((value) => value + sanitizedInput);
    }
  });

  async function submit() {
    setError(null);

    if (step === "provider") {
      const selectedProvider =
        SELECTABLE_OPENWIKI_PROVIDERS[providerSelectionIndex] ??
        DEFAULT_PROVIDER;

      setProvider(selectedProvider);
      setProviderSelectionIndex(getProviderSelectionIndex(selectedProvider));
      setModelSelectionIndex(
        getModelSelectionIndex(
          selectedProvider,
          getDefaultModelId(selectedProvider),
        ),
      );
      setInput("");
      // If the provider changed, re-confirm the model even when one is already
      // stored (it may belong to the previous provider).
      const providerChanged =
        process.env[OPENWIKI_PROVIDER_ENV_KEY] !== selectedProvider;

      setForceModelStep(providerChanged);
      const nextStep = getNextStepAfterProvider(
        selectedProvider,
        modelIdOverride,
        providerChanged,
      );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" &&
            shouldStartWithCustomModelInput(selectedProvider),
        );
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextProvider: selectedProvider,
      });
      return;
    }

    if (step === "api-key") {
      const trimmedInput = input.trim();

      if (trimmedInput.length === 0) {
        setError(`${getProviderApiKeyEnvKey(provider)} is required.`);
        return;
      }

      setApiKey(trimmedInput);
      setInput("");
      const nextStep = getNextStepAfterApiKey(
        provider,
        modelIdOverride,
        forceModelStep,
      );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" && shouldStartWithCustomModelInput(provider),
        );
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: trimmedInput,
        nextBaseUrl: baseUrl,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextProvider: provider,
      });
      return;
    }

    if (step === "base-url") {
      const trimmedInput = input.trim();

      if (trimmedInput.length === 0) {
        setError(
          `${getProviderBaseUrlEnvKey(provider) ?? "Base URL"} is required.`,
        );
        return;
      }

      if (!isValidBaseUrl(trimmedInput)) {
        setError("Enter a valid http(s) base URL.");
        return;
      }

      setBaseUrl(trimmedInput);
      setInput("");
      const nextStep = getNextStepAfterBaseUrl(
        provider,
        modelIdOverride,
        forceModelStep,
      );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" && shouldStartWithCustomModelInput(provider),
        );
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: trimmedInput,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextProvider: provider,
      });
      return;
    }

    if (step === "model") {
      const selectedModelId = getSelectedModelId(
        provider,
        modelSelectionIndex,
        input,
        isCustomModelInput,
      );

      if (!selectedModelId) {
        setError("Paste a valid model ID.");
        return;
      }

      if (selectedModelId === "custom") {
        setIsCustomModelInput(true);
        setInput("");
        return;
      }

      setModelId(selectedModelId);
      setInput("");
      setIsCustomModelInput(false);

      if (process.env.LANGSMITH_API_KEY === undefined) {
        setStep("langsmith");
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextLangSmithKey: langSmithKey,
        nextModelId: selectedModelId,
        nextProvider: provider,
      });
      return;
    }

    if (step === "langsmith") {
      const nextLangSmithKey = input.trim();

      setLangSmithKey(nextLangSmithKey);
      setInput("");

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextLangSmithKey,
        nextModelId: modelId,
        nextProvider: provider,
      });
    }
  }

  type CompleteSetupOptions = {
    nextApiKey: string | null;
    nextBaseUrl: string | null;
    nextLangSmithKey: string | null;
    nextModelId: string | null;
    nextProvider: OpenWikiProvider;
    nextOAuthTokens?: CodexTokens | null;
  };

  async function completeSetup({
    nextApiKey,
    nextBaseUrl,
    nextLangSmithKey,
    nextModelId,
    nextProvider,
    nextOAuthTokens = oauthTokens,
  }: CompleteSetupOptions) {
    setIsSaving(true);

    try {
      const updates: Record<string, string> = {};
      const providerEnvChanged =
        process.env[OPENWIKI_PROVIDER_ENV_KEY] !== nextProvider;

      if (providerEnvChanged) {
        updates[OPENWIKI_PROVIDER_ENV_KEY] = nextProvider;
      }

      if (nextApiKey !== null) {
        updates[getProviderApiKeyEnvKey(nextProvider)] = nextApiKey;
      }

      if (nextOAuthTokens) {
        Object.assign(updates, codexTokensToEnv(nextOAuthTokens));
      }

      if (nextBaseUrl !== null) {
        const baseUrlEnvKey = getProviderBaseUrlEnvKey(nextProvider);

        if (baseUrlEnvKey) {
          updates[baseUrlEnvKey] = nextBaseUrl;
        }
      }

      if (nextModelId !== null) {
        updates[OPENWIKI_MODEL_ID_ENV_KEY] = nextModelId;
      }

      if (nextLangSmithKey !== null) {
        updates.LANGSMITH_API_KEY = nextLangSmithKey;

        if (nextLangSmithKey.length > 0) {
          updates.LANGCHAIN_PROJECT = "openwiki";
          updates.LANGCHAIN_TRACING_V2 = "true";
        } else {
          // Blank input must act as an off switch: without this, a
          // LANGCHAIN_TRACING_V2=true saved by an earlier setup stays in
          // ~/.openwiki/.env and tracing silently remains enabled.
          updates.LANGCHAIN_TRACING_V2 = "false";
        }
      }

      if (Object.keys(updates).length > 0) {
        await saveOpenWikiEnv(updates);
      }

      onComplete({
        modelId:
          nextModelId ??
          modelIdOverride ??
          process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
          null,
        provider: nextProvider,
        savedApiKey: nextApiKey !== null || nextOAuthTokens != null,
        savedBaseUrl: nextBaseUrl !== null,
        savedLangSmithKey:
          nextLangSmithKey !== null && nextLangSmithKey.length > 0,
        savedModelId: nextModelId !== null,
        savedProvider: providerEnvChanged,
      });
    } catch (saveError) {
      onError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to complete OpenWiki credential setup.",
      );
    }
  }

  function submitManualLogin(pasted: string): void {
    const handle = loginHandleRef.current;

    if (!handle) {
      setError("Login is still starting — try again in a moment.");
      return;
    }

    const errorMessage = handle.submitManual(pasted);

    if (errorMessage) {
      setError(errorMessage);
      return;
    }

    // Accepted: the pending login promise resolves with this code and the
    // effect above advances the wizard once the token exchange finishes.
    setInput("");
    setError(null);
  }

  const needsCredentialPrompt = needsCredentialSetup(modelIdOverride);

  return (
    <Box flexDirection="column">
      <SetupHeader />

      <Box flexDirection="column" marginBottom={1}>
        <SetupStep
          label="Provider"
          state={
            process.env[OPENWIKI_PROVIDER_ENV_KEY]
              ? "done"
              : step === "provider"
                ? "current"
                : "pending"
          }
          detail={getProviderSetupDetail(provider)}
        />
        <SetupStep
          label={providerUsesOAuth(provider) ? "ChatGPT login" : "Provider key"}
          state={
            isCredentialConfigured(provider) || oauthTokens
              ? "done"
              : step === credentialStep(provider)
                ? "current"
                : "pending"
          }
          detail={getCredentialSetupDetail(provider, oauthTokens)}
        />
        {providerRequiresBaseUrl(provider) ? (
          <SetupStep
            label="Base URL"
            state={
              isBaseUrlConfigured(provider)
                ? "done"
                : step === "base-url"
                  ? "current"
                  : "pending"
            }
            detail={
              isBaseUrlConfigured(provider)
                ? "available from environment"
                : `save ${getProviderBaseUrlEnvKey(provider)} to ${openWikiEnvPath}`
            }
          />
        ) : null}
        <SetupStep
          label="Model"
          state={
            modelIdOverride || process.env[OPENWIKI_MODEL_ID_ENV_KEY]
              ? "done"
              : step === "model"
                ? "current"
                : "pending"
          }
          detail={getModelSetupDetail(modelIdOverride, provider)}
        />
        <SetupStep
          label="LangSmith"
          state={
            process.env.LANGSMITH_API_KEY !== undefined
              ? "done"
              : step === "langsmith"
                ? "current"
                : "optional"
          }
          detail={
            process.env.LANGSMITH_API_KEY !== undefined
              ? "available from environment"
              : "optional tracing key"
          }
        />
        <SetupStep label="OpenWiki" state="done" detail="agent setup" />
      </Box>

      {step === "oauth-login" ? (
        // Rendered outside the bordered panel so the long URL is not wrapped
        // with `│` side borders, which makes it impossible to select/copy.
        <OAuthLoginPrompt
          copied={copied}
          input={input}
          isLoggingIn={isLoggingIn}
          loginUrl={loginUrl}
          provider={provider}
        />
      ) : (
        <SetupPanel title="Prompt">
          {step ? (
            <Prompt
              input={input}
              isCustomModelInput={isCustomModelInput}
              modelSelectionIndex={modelSelectionIndex}
              provider={provider}
              providerSelectionIndex={providerSelectionIndex}
              step={step}
            />
          ) : (
            <Text>Inspecting OpenWiki setup...</Text>
          )}
        </SetupPanel>
      )}

      {needsCredentialPrompt ? (
        <Text color="gray">Secrets are masked and saved only after setup.</Text>
      ) : null}

      {error ? (
        <SetupPanel title="Error">
          <Text color="red">{error}</Text>
        </SetupPanel>
      ) : null}
      {isSaving ? (
        <SetupPanel title="Saving">
          <Text>Writing OpenWiki setup...</Text>
        </SetupPanel>
      ) : null}
    </Box>
  );
}

function SetupHeader() {
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
    >
      <Text>
        <Text bold color="cyan">
          OpenWiki
        </Text>{" "}
        <Text color="gray">credential setup</Text>
      </Text>
      <Text>Configure a model provider and local defaults.</Text>
    </Box>
  );
}

type SetupStepProps = {
  label: string;
  state: "current" | "done" | "optional" | "pending";
  detail: string;
};

function SetupStep({ label, state, detail }: SetupStepProps) {
  const color =
    state === "done"
      ? "green"
      : state === "current"
        ? "yellow"
        : state === "optional"
          ? "cyan"
          : "gray";

  return (
    <Text>
      <Text color={color}>[{state.toUpperCase()}]</Text>{" "}
      <Text bold>{label.padEnd(16)}</Text> <Text color="gray">{detail}</Text>
    </Text>
  );
}

type SetupPanelProps = {
  title: string;
  children: React.ReactNode;
};

function SetupPanel({ title, children }: SetupPanelProps) {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      flexDirection="column"
      marginTop={1}
      paddingX={1}
    >
      <Text bold color="cyan">
        {title}
      </Text>
      {children}
    </Box>
  );
}

type OAuthLoginPromptProps = {
  copied: boolean;
  input: string;
  isLoggingIn: boolean;
  loginUrl: string | null;
  provider: OpenWikiProvider;
};

function OAuthLoginPrompt({
  copied,
  input,
  isLoggingIn,
  loginUrl,
  provider,
}: OAuthLoginPromptProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        ChatGPT login
      </Text>
      <Text>
        Sign in with your {getProviderLabel(provider)} account to authorize
        OpenWiki.
      </Text>
      {loginUrl ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">
            Opening your browser. If it does not open, copy this URL:
          </Text>
          <Text color="cyan">{loginUrl}</Text>
          <Text color="gray">
            Press <Text bold>c</Text> to copy the URL
            {copied ? <Text color="green"> (copied)</Text> : null}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">
              If the browser can&apos;t reach this machine (e.g. a remote/SSH
              host), paste the URL you were redirected to — or the code — and
              press Enter:
            </Text>
            <Text>
              <Text color="gray">&gt; </Text>
              {input.length > 0 ? (
                <Text color="yellow">{input}</Text>
              ) : (
                <Text color="gray">(paste here)</Text>
              )}
            </Text>
          </Box>
        </Box>
      ) : (
        <Text color="gray">Starting the ChatGPT login...</Text>
      )}
      <Text color="gray">
        {isLoggingIn
          ? "Waiting for browser sign-in or pasted URL..."
          : "Login failed. Press Enter to retry."}
      </Text>
    </Box>
  );
}

type PromptProps = {
  input: string;
  isCustomModelInput: boolean;
  modelSelectionIndex: number;
  provider: OpenWikiProvider;
  providerSelectionIndex: number;
  step: PromptStep;
};

function Prompt({
  input,
  isCustomModelInput,
  modelSelectionIndex,
  provider,
  providerSelectionIndex,
  step,
}: PromptProps) {
  if (step === "provider") {
    return (
      <Box flexDirection="column">
        <Text>Choose a model provider.</Text>
        {SELECTABLE_OPENWIKI_PROVIDERS.map((providerOption, index) => (
          <Text key={providerOption}>
            <SelectionMarker isSelected={index === providerSelectionIndex} />{" "}
            {getProviderLabel(providerOption)}
            <Text color="gray"> ({providerOption})</Text>
            {providerOption === DEFAULT_PROVIDER ? (
              <Text color="gray"> default</Text>
            ) : null}
          </Text>
        ))}
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "api-key") {
    return (
      <Box flexDirection="column">
        <Text>Paste your {getProviderLabel(provider)} API key.</Text>
        <Text>
          <Text color="gray">$</Text> {getProviderApiKeyEnvKey(provider)}={" "}
          <Text color="yellow">{mask(input)}</Text>
        </Text>
        <Text color="gray">Press Enter to save it.</Text>
      </Box>
    );
  }

  if (step === "base-url") {
    return (
      <Box flexDirection="column">
        <Text>Enter the {getProviderLabel(provider)} base URL.</Text>
        <Text>
          <Text color="gray">$</Text> {getProviderBaseUrlEnvKey(provider)}={" "}
          <Text color="yellow">{input}</Text>
        </Text>
        <Text color="gray">
          For example an OpenAI-compatible gateway endpoint (such as a LiteLLM
          gateway). Press Enter to save it.
        </Text>
      </Box>
    );
  }

  if (step === "model") {
    if (isCustomModelInput) {
      return (
        <Box flexDirection="column">
          <Text>Paste a custom model ID.</Text>
          <Text>
            <Text color="gray">$</Text> {OPENWIKI_MODEL_ID_ENV_KEY}={" "}
            <Text color="yellow">{input}</Text>
          </Text>
          <Text color="gray">Press Enter to save it.</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Text>
          Choose {getProviderArticle(provider)} {getProviderLabel(provider)}{" "}
          model.
        </Text>
        {getModelSelectionOptions(provider).map((option, index) => {
          if (option.kind === "custom") {
            return (
              <Text key="custom">
                <SelectionMarker isSelected={index === modelSelectionIndex} />{" "}
                Custom model ID
              </Text>
            );
          }

          return (
            <Text key={option.id}>
              <SelectionMarker isSelected={index === modelSelectionIndex} />{" "}
              {option.label} <Text color="gray">{option.id}</Text>
              {option.id === getDefaultModelId(provider) ? (
                <Text color="gray"> default</Text>
              ) : null}
            </Text>
          );
        })}
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "langsmith") {
    return (
      <Text>
        <Text color="gray">$</Text> LANGSMITH_API_KEY optional={" "}
        <Text color="yellow">{mask(input)}</Text>
      </Text>
    );
  }

  return null;
}

function SelectionMarker({ isSelected }: { isSelected: boolean }) {
  return (
    <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? ">" : " "}</Text>
  );
}

export function getInitialStep(
  modelIdOverride: string | null,
  provider: OpenWikiProvider,
): PromptStep | null {
  if (process.env[OPENWIKI_PROVIDER_ENV_KEY] === undefined) {
    return "provider";
  }

  if (needsCredentialStep(provider)) {
    return credentialStep(provider);
  }

  if (needsBaseUrlStep(provider)) {
    return "base-url";
  }

  if (
    modelIdOverride === null &&
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined
  ) {
    return "model";
  }

  if (process.env.LANGSMITH_API_KEY === undefined) {
    return "langsmith";
  }

  return null;
}

export function getNextStepAfterProvider(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  forceModel = false,
): PromptStep | null {
  if (needsCredentialStep(provider)) {
    return credentialStep(provider);
  }

  return getNextStepAfterApiKey(provider, modelIdOverride, forceModel);
}

function getNextStepAfterApiKey(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  forceModel = false,
): PromptStep | null {
  if (needsBaseUrlStep(provider)) {
    return "base-url";
  }

  return getNextStepAfterBaseUrl(provider, modelIdOverride, forceModel);
}

function getNextStepAfterBaseUrl(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  forceModel = false,
): PromptStep | null {
  // Ask for the model when none is configured, or when the provider was just
  // (re)selected in the wizard — the stored model id may belong to the old
  // provider, so re-confirm it (unless a per-run --modelId override is set).
  if (
    modelIdOverride === null &&
    (forceModel || process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined)
  ) {
    return "model";
  }

  if (process.env.LANGSMITH_API_KEY === undefined) {
    return "langsmith";
  }

  return null;
}

function getProviderSetupDetail(provider: OpenWikiProvider): string {
  if (process.env[OPENWIKI_PROVIDER_ENV_KEY]) {
    return getProviderLabel(provider);
  }

  return `default ${getProviderLabel(DEFAULT_PROVIDER)}`;
}

function getModelSetupDetail(
  modelIdOverride: string | null,
  provider: OpenWikiProvider,
): string {
  if (modelIdOverride) {
    return `using ${modelIdOverride} for this run`;
  }

  if (process.env[OPENWIKI_MODEL_ID_ENV_KEY]) {
    return process.env[OPENWIKI_MODEL_ID_ENV_KEY] ?? "";
  }

  return `default ${getDefaultModelId(provider)}`;
}

type ModelSelectionOption =
  | {
      id: string;
      kind: "preset";
      label: string;
    }
  | {
      kind: "custom";
    };

function getModelSelectionOptions(
  provider: OpenWikiProvider,
): ModelSelectionOption[] {
  return [
    ...getProviderModelOptions(provider).map((model) => ({
      id: model.id,
      kind: "preset" as const,
      label: model.label,
    })),
    { kind: "custom" },
  ];
}

function shouldStartWithCustomModelInput(provider: OpenWikiProvider): boolean {
  return getProviderModelOptions(provider).length === 0;
}

function getSelectedModelId(
  provider: OpenWikiProvider,
  selectedIndex: number,
  input: string,
  isCustomInput: boolean,
): string | "custom" | null {
  if (!isCustomInput) {
    const selectedOption = getModelSelectionOptions(provider)[selectedIndex];

    if (!selectedOption) {
      return null;
    }

    return selectedOption.kind === "custom" ? "custom" : selectedOption.id;
  }

  const normalizedModelId = normalizeModelId(input);

  return isValidModelId(normalizedModelId) ? normalizedModelId : null;
}

function getProviderSelectionIndex(provider: OpenWikiProvider): number {
  const selectedIndex = SELECTABLE_OPENWIKI_PROVIDERS.findIndex(
    (providerOption) => providerOption === provider,
  );

  return selectedIndex === -1 ? 0 : selectedIndex;
}

function getModelSelectionIndex(
  provider: OpenWikiProvider,
  selectedModelId: string,
): number {
  const selectedIndex = getModelSelectionOptions(provider).findIndex(
    (option) => option.kind === "preset" && option.id === selectedModelId,
  );

  return selectedIndex === -1 ? 0 : selectedIndex;
}

function moveSelectionIndex(
  currentIndex: number,
  offset: number,
  itemCount: number,
): number {
  if (itemCount <= 0) {
    return 0;
  }

  return (currentIndex + offset + itemCount) % itemCount;
}

function getProviderArticle(provider: OpenWikiProvider): "a" | "an" {
  return provider === "baseten" || provider === "fireworks" ? "a" : "an";
}

function sanitizeInputChunk(value: string): string {
  return value.replace(/[\r\n]/gu, "");
}

function mask(value: string): string {
  if (value.length === 0) {
    return "";
  }

  return "*".repeat(value.length);
}
