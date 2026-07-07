import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  DEFAULT_PROVIDER,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderLabel,
  getProviderModelOptions,
  getProviderRegionEnvKey,
  isValidBaseUrl,
  isValidModelId,
  normalizeModelId,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  type OpenWikiProvider,
  type ProviderModelOption,
  providerRequiresBaseUrl,
  providerUsesAwsCredentials,
  resolveConfiguredProvider,
  resolveProviderRegion,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "./constants.js";
import { openWikiEnvPath, saveOpenWikiEnv } from "./env.js";

export type InitSetupResult = {
  modelId: string | null;
  provider: OpenWikiProvider | null;
  savedApiKey: boolean;
  savedBaseUrl: boolean;
  savedLangSmithKey: boolean;
  savedModelId: boolean;
  savedProvider: boolean;
  savedRegion: boolean;
};

type InitSetupProps = {
  modelIdOverride?: string | null;
  onComplete: (result: InitSetupResult) => void;
  onError: (message: string) => void;
};

type PromptStep =
  | "api-key"
  | "base-url"
  | "bedrock-key"
  | "langsmith"
  | "model"
  | "provider"
  | "region";

export function needsCredentialSetup(
  modelIdOverride: string | null = null,
): boolean {
  const provider = resolveConfiguredProvider();

  return (
    process.env[OPENWIKI_PROVIDER_ENV_KEY] === undefined ||
    needsProviderCredentialStep(provider) ||
    needsBaseUrlStep(provider) ||
    (modelIdOverride === null &&
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined) ||
    process.env.LANGSMITH_API_KEY === undefined
  );
}

function needsProviderCredentialStep(provider: OpenWikiProvider): boolean {
  if (providerUsesAwsCredentials(provider)) {
    return needsRegionStep(provider);
  }

  return !process.env[getProviderApiKeyEnvKey(provider)];
}

function needsRegionStep(provider: OpenWikiProvider): boolean {
  if (!providerUsesAwsCredentials(provider)) {
    return false;
  }

  return !resolveProviderRegion(provider);
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
  const [region, setRegion] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [langSmithKey, setLangSmithKey] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [providerSelectionIndex, setProviderSelectionIndex] = useState(() =>
    getProviderSelectionIndex(initialProvider),
  );
  const [modelSelectionIndex, setModelSelectionIndex] = useState(() =>
    getModelSelectionIndex(
      getProviderModelOptions(initialProvider),
      modelIdOverride ??
        process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
        getDefaultModelId(initialProvider),
    ),
  );
  const [isCustomModelInput, setIsCustomModelInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const modelOptions = getProviderModelOptions(provider);

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
        savedRegion: false,
      });
      return;
    }

    setProvider(initialProvider);
    setProviderSelectionIndex(getProviderSelectionIndex(initialProvider));
    setModelSelectionIndex(
      getModelSelectionIndex(
        getProviderModelOptions(initialProvider),
        modelIdOverride ??
          process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
          getDefaultModelId(initialProvider),
      ),
    );
    setIsCustomModelInput(
      initialStep === "model" &&
        shouldStartWithCustomModelInput(
          getProviderModelOptions(initialProvider),
        ),
    );
    setStep(initialStep);
  }, [initialProvider, modelIdOverride, onComplete]);

  useInput((inputValue, key) => {
    if (isSaving || step === null) {
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
            getModelSelectionOptions(modelOptions).length,
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
          getProviderModelOptions(selectedProvider),
          getDefaultModelId(selectedProvider),
        ),
      );
      setInput("");
      const nextStep = getNextStepAfterProvider(
        selectedProvider,
        modelIdOverride,
      );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" &&
            shouldStartWithCustomModelInput(
              getProviderModelOptions(selectedProvider),
            ),
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
        nextRegion: region,
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
      const nextStep = getNextStepAfterApiKey(provider, modelIdOverride);

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" &&
            shouldStartWithCustomModelInput(getProviderModelOptions(provider)),
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
        nextRegion: region,
      });
      return;
    }

    if (step === "region") {
      const trimmedInput = input.trim();

      if (trimmedInput.length === 0) {
        setError(
          `${getProviderRegionEnvKey(provider) ?? "AWS_REGION"} is required.`,
        );
        return;
      }

      setRegion(trimmedInput);
      setInput("");
      setStep("bedrock-key");
      return;
    }

    if (step === "bedrock-key") {
      const trimmedInput = input.trim();
      const nextApiKey = trimmedInput.length > 0 ? trimmedInput : null;

      setApiKey(nextApiKey);
      setInput("");
      const nextStep = getNextStepAfterBaseUrl(provider, modelIdOverride);

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" &&
            shouldStartWithCustomModelInput(getProviderModelOptions(provider)),
        );
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey,
        nextBaseUrl: baseUrl,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextProvider: provider,
        nextRegion: region,
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
      const nextStep = getNextStepAfterBaseUrl(provider, modelIdOverride);

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" &&
            shouldStartWithCustomModelInput(getProviderModelOptions(provider)),
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
        nextRegion: region,
      });
      return;
    }

    if (step === "model") {
      const selectedModelId = getSelectedModelId(
        modelOptions,
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
        nextRegion: region,
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
        nextRegion: region,
      });
    }
  }

  type CompleteSetupOptions = {
    nextApiKey: string | null;
    nextBaseUrl: string | null;
    nextLangSmithKey: string | null;
    nextModelId: string | null;
    nextProvider: OpenWikiProvider;
    nextRegion: string | null;
  };

  async function completeSetup({
    nextApiKey,
    nextBaseUrl,
    nextLangSmithKey,
    nextModelId,
    nextProvider,
    nextRegion,
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

      if (nextBaseUrl !== null) {
        const baseUrlEnvKey = getProviderBaseUrlEnvKey(nextProvider);

        if (baseUrlEnvKey) {
          updates[baseUrlEnvKey] = nextBaseUrl;
        }
      }

      if (nextRegion !== null) {
        const regionEnvKey = getProviderRegionEnvKey(nextProvider);

        if (regionEnvKey) {
          updates[regionEnvKey] = nextRegion;
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
        savedApiKey: nextApiKey !== null,
        savedBaseUrl: nextBaseUrl !== null,
        savedLangSmithKey:
          nextLangSmithKey !== null && nextLangSmithKey.length > 0,
        savedModelId: nextModelId !== null,
        savedProvider: providerEnvChanged,
        savedRegion: nextRegion !== null,
      });
    } catch (saveError) {
      onError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to complete OpenWiki credential setup.",
      );
    }
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
        {providerUsesAwsCredentials(provider) ? (
          <>
            <SetupStep
              label="Region"
              state={
                resolveProviderRegion(provider)
                  ? "done"
                  : step === "region"
                    ? "current"
                    : "pending"
              }
              detail={
                resolveProviderRegion(provider)
                  ? "available from environment"
                  : `save ${getProviderRegionEnvKey(provider)} to ${openWikiEnvPath}`
              }
            />
            <SetupStep
              label="Bedrock API key"
              state={
                process.env[getProviderApiKeyEnvKey(provider)]
                  ? "done"
                  : step === "bedrock-key"
                    ? "current"
                    : "optional"
              }
              detail={
                process.env[getProviderApiKeyEnvKey(provider)]
                  ? "available from environment"
                  : "optional; otherwise the AWS credential chain is used"
              }
            />
          </>
        ) : (
          <>
            <SetupStep
              label="Provider key"
              state={
                process.env[getProviderApiKeyEnvKey(provider)]
                  ? "done"
                  : step === "api-key"
                    ? "current"
                    : "pending"
              }
              detail={
                process.env[getProviderApiKeyEnvKey(provider)]
                  ? "available from environment"
                  : `save ${getProviderApiKeyEnvKey(provider)} to ${openWikiEnvPath}`
              }
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
          </>
        )}
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

      <SetupPanel title="Prompt">
        {step ? (
          <Prompt
            input={input}
            isCustomModelInput={isCustomModelInput}
            modelOptions={modelOptions}
            modelSelectionIndex={modelSelectionIndex}
            provider={provider}
            providerSelectionIndex={providerSelectionIndex}
            step={step}
          />
        ) : (
          <Text>Inspecting OpenWiki setup...</Text>
        )}
      </SetupPanel>

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

type PromptProps = {
  input: string;
  isCustomModelInput: boolean;
  modelOptions: ProviderModelOption[];
  modelSelectionIndex: number;
  provider: OpenWikiProvider;
  providerSelectionIndex: number;
  step: PromptStep;
};

function Prompt({
  input,
  isCustomModelInput,
  modelOptions,
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

  if (step === "region") {
    return (
      <Box flexDirection="column">
        <Text>Enter the AWS region for {getProviderLabel(provider)}.</Text>
        <Text>
          <Text color="gray">$</Text> {getProviderRegionEnvKey(provider)}={" "}
          <Text color="yellow">{input}</Text>
        </Text>
        <Text color="gray">For example us-east-1. Press Enter to save it.</Text>
      </Box>
    );
  }

  if (step === "bedrock-key") {
    return (
      <Box flexDirection="column">
        <Text>
          Paste a Bedrock API key, or leave blank to use AWS credentials.
        </Text>
        <Text>
          <Text color="gray">$</Text> {getProviderApiKeyEnvKey(provider)}{" "}
          optional= <Text color="yellow">{mask(input)}</Text>
        </Text>
        <Text color="gray">
          Leave blank to authenticate through the AWS credential chain (IAM
          role, SSO, profile, or access keys). Press Enter to continue.
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
        {getModelSelectionOptions(modelOptions).map((option, index) => {
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

function getInitialStep(
  modelIdOverride: string | null,
  provider: OpenWikiProvider,
): PromptStep | null {
  if (process.env[OPENWIKI_PROVIDER_ENV_KEY] === undefined) {
    return "provider";
  }

  if (providerUsesAwsCredentials(provider)) {
    if (needsRegionStep(provider)) {
      return "region";
    }

    return getNextStepAfterBaseUrl(provider, modelIdOverride);
  }

  if (!process.env[getProviderApiKeyEnvKey(provider)]) {
    return "api-key";
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

function getNextStepAfterProvider(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
): PromptStep | null {
  if (providerUsesAwsCredentials(provider)) {
    if (needsRegionStep(provider)) {
      return "region";
    }

    return getNextStepAfterBaseUrl(provider, modelIdOverride);
  }

  if (!process.env[getProviderApiKeyEnvKey(provider)]) {
    return "api-key";
  }

  return getNextStepAfterApiKey(provider, modelIdOverride);
}

function getNextStepAfterApiKey(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
): PromptStep | null {
  if (needsBaseUrlStep(provider)) {
    return "base-url";
  }

  return getNextStepAfterBaseUrl(provider, modelIdOverride);
}

function getNextStepAfterBaseUrl(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
): PromptStep | null {
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
  models: ProviderModelOption[],
): ModelSelectionOption[] {
  return [
    ...models.map((model) => ({
      id: model.id,
      kind: "preset" as const,
      label: model.label,
    })),
    { kind: "custom" },
  ];
}

function shouldStartWithCustomModelInput(
  models: ProviderModelOption[],
): boolean {
  return models.length === 0;
}

function getSelectedModelId(
  models: ProviderModelOption[],
  selectedIndex: number,
  input: string,
  isCustomInput: boolean,
): string | null {
  if (!isCustomInput) {
    const selectedOption = getModelSelectionOptions(models)[selectedIndex];

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
  models: ProviderModelOption[],
  selectedModelId: string,
): number {
  const selectedIndex = getModelSelectionOptions(models).findIndex(
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
