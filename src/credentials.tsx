import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  DEFAULT_PROVIDER,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderLabel,
  getProviderModelOptions,
  isValidModelId,
  normalizeModelId,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  type OpenWikiProvider,
  resolveConfiguredProvider,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "./constants.js";
import { openWikiEnvPath, saveOpenWikiEnv } from "./env.js";

export type InitSetupResult = {
  modelId: string | null;
  provider: OpenWikiProvider | null;
  savedApiKey: boolean;
  savedLangSmithKey: boolean;
  savedModelId: boolean;
  savedProvider: boolean;
};

type InitSetupProps = {
  modelIdOverride?: string | null;
  reconfigure?: boolean;
  onComplete: (result: InitSetupResult) => void;
  onError: (message: string) => void;
};

type PromptStep =
  | "api-key"
  | "langsmith"
  | "model"
  | "provider"
  | "custom-base-url";

export function needsCredentialSetup(
  modelIdOverride: string | null = null,
): boolean {
  const provider = resolveConfiguredProvider();
  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);

  return (
    process.env[OPENWIKI_PROVIDER_ENV_KEY] === undefined ||
    (provider === "custom" && !process.env.OPENWIKI_CUSTOM_BASE_URL) ||
    !process.env[apiKeyEnvKey] ||
    (modelIdOverride === null &&
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined) ||
    process.env.LANGSMITH_API_KEY === undefined
  );
}

export function InitSetup({
  modelIdOverride = null,
  reconfigure = false,
  onComplete,
  onError,
}: InitSetupProps) {
  const initialProvider = resolveConfiguredProvider();
  const [step, setStep] = useState<PromptStep | null>(null);
  const [provider, setProvider] = useState<OpenWikiProvider>(initialProvider);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [customBaseUrl, setCustomBaseUrl] = useState<string | null>(null);
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

  useEffect(() => {
    const initialStep = getInitialStep(
      modelIdOverride,
      initialProvider,
      reconfigure,
    );

    if (initialStep === null) {
      onComplete({
        modelId:
          modelIdOverride ?? process.env[OPENWIKI_MODEL_ID_ENV_KEY] ?? null,
        provider: initialProvider,
        savedApiKey: false,
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
    setIsCustomModelInput(false);
    setStep(initialStep);
  }, [initialProvider, modelIdOverride, reconfigure, onComplete]);

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
      setIsCustomModelInput(false);
      setInput("");
      const nextStep = getNextStepAfterProvider(
        selectedProvider,
        modelIdOverride,
        reconfigure,
      );

      if (nextStep) {
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextCustomBaseUrl: customBaseUrl,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextProvider: selectedProvider,
      });
      return;
    }

    if (step === "custom-base-url") {
      const trimmedInput = input.trim();

      if (trimmedInput.length === 0) {
        const existingBaseUrl = process.env.OPENWIKI_CUSTOM_BASE_URL;
        if (reconfigure && existingBaseUrl) {
          setCustomBaseUrl(null);
          setInput("");
          const nextStep = getNextStepAfterCustomBaseUrl(
            provider,
            modelIdOverride,
            reconfigure,
          );
          if (nextStep) {
            setStep(nextStep);
            return;
          }
          await completeSetup({
            nextApiKey: apiKey,
            nextCustomBaseUrl: null,
            nextLangSmithKey: langSmithKey,
            nextModelId: modelId,
            nextProvider: provider,
          });
          return;
        }
        setError("OPENWIKI_CUSTOM_BASE_URL is required.");
        return;
      }

      setCustomBaseUrl(trimmedInput);
      setInput("");
      const nextStep = getNextStepAfterCustomBaseUrl(
        provider,
        modelIdOverride,
        reconfigure,
      );

      if (nextStep) {
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextCustomBaseUrl: trimmedInput,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextProvider: provider,
      });
      return;
    }

    if (step === "api-key") {
      const trimmedInput = input.trim();

      if (trimmedInput.length === 0) {
        const existingKey = process.env[getProviderApiKeyEnvKey(provider)];
        if (reconfigure && existingKey) {
          setApiKey(null);
          setInput("");
          const nextStep = getNextStepAfterApiKey(
            provider,
            modelIdOverride,
            reconfigure,
          );
          if (nextStep) {
            setStep(nextStep);
            return;
          }
          await completeSetup({
            nextApiKey: null,
            nextCustomBaseUrl: customBaseUrl,
            nextLangSmithKey: langSmithKey,
            nextModelId: modelId,
            nextProvider: provider,
          });
          return;
        }
        setError(`${getProviderApiKeyEnvKey(provider)} is required.`);
        return;
      }

      setApiKey(trimmedInput);
      setInput("");
      const nextStep = getNextStepAfterApiKey(
        provider,
        modelIdOverride,
        reconfigure,
      );

      if (nextStep) {
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: trimmedInput,
        nextCustomBaseUrl: customBaseUrl,
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

      if (reconfigure || process.env.LANGSMITH_API_KEY === undefined) {
        setStep("langsmith");
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextCustomBaseUrl: customBaseUrl,
        nextLangSmithKey: langSmithKey,
        nextModelId: selectedModelId,
        nextProvider: provider,
      });
      return;
    }

    if (step === "langsmith") {
      let nextLangSmithKey: string | null = input.trim();
      const hasExisting = process.env.LANGSMITH_API_KEY !== undefined;

      if (reconfigure && hasExisting && nextLangSmithKey.length === 0) {
        nextLangSmithKey = null;
      } else if (nextLangSmithKey.toLowerCase() === "none") {
        nextLangSmithKey = "";
      }

      setLangSmithKey(nextLangSmithKey);
      setInput("");

      await completeSetup({
        nextApiKey: apiKey,
        nextCustomBaseUrl: customBaseUrl,
        nextLangSmithKey,
        nextModelId: modelId,
        nextProvider: provider,
      });
    }
  }

  type CompleteSetupOptions = {
    nextApiKey: string | null;
    nextCustomBaseUrl?: string | null;
    nextLangSmithKey: string | null;
    nextModelId: string | null;
    nextProvider: OpenWikiProvider;
  };

  async function completeSetup({
    nextApiKey,
    nextCustomBaseUrl,
    nextLangSmithKey,
    nextModelId,
    nextProvider,
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

      if (nextCustomBaseUrl !== undefined && nextCustomBaseUrl !== null) {
        updates.OPENWIKI_CUSTOM_BASE_URL = nextCustomBaseUrl;
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
          updates.LANGCHAIN_PROJECT = "";
          updates.LANGCHAIN_TRACING_V2 = "";
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
        {provider === "custom" ? (
          <SetupStep
            label="Custom base URL"
            state={
              process.env.OPENWIKI_CUSTOM_BASE_URL
                ? "done"
                : step === "custom-base-url"
                  ? "current"
                  : "pending"
            }
            detail={
              process.env.OPENWIKI_CUSTOM_BASE_URL
                ? process.env.OPENWIKI_CUSTOM_BASE_URL
                : `save OPENWIKI_CUSTOM_BASE_URL to ${openWikiEnvPath}`
            }
          />
        ) : null}
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

  if (step === "custom-base-url") {
    const hasExisting = process.env.OPENWIKI_CUSTOM_BASE_URL !== undefined;
    return (
      <Box flexDirection="column">
        <Text>
          {hasExisting
            ? "Paste a new custom OpenAI-compatible API base URL, or press Enter to keep current URL."
            : "Paste your custom OpenAI-compatible API base URL (e.g., http://localhost:11434/v1)."}
        </Text>
        <Text>
          <Text color="gray">$</Text> OPENWIKI_CUSTOM_BASE_URL={" "}
          <Text color="yellow">{input}</Text>
        </Text>
        <Text color="gray">
          {hasExisting
            ? "Press Enter to keep current URL."
            : "Press Enter to save."}
        </Text>
      </Box>
    );
  }

  if (step === "api-key") {
    const hasExisting =
      process.env[getProviderApiKeyEnvKey(provider)] !== undefined;
    return (
      <Box flexDirection="column">
        <Text>
          {hasExisting
            ? `Paste a new ${getProviderApiKeyEnvKey(provider)}, or press Enter to keep current key.`
            : `Paste your ${getProviderLabel(provider)} API key.`}
        </Text>
        <Text>
          <Text color="gray">$</Text> {getProviderApiKeyEnvKey(provider)}={" "}
          <Text color="yellow">{mask(input)}</Text>
        </Text>
        <Text color="gray">
          {hasExisting
            ? "Press Enter to keep current key."
            : "Press Enter to save."}
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
    const hasExisting = process.env.LANGSMITH_API_KEY !== undefined;
    return (
      <Box flexDirection="column">
        <Text>
          {hasExisting
            ? "Paste a new LangSmith API key, or press Enter to keep current key."
            : "Paste an optional LangSmith API key."}
        </Text>
        <Text>
          <Text color="gray">$</Text> LANGSMITH_API_KEY={" "}
          <Text color="yellow">{mask(input)}</Text>
        </Text>
        <Text color="gray">
          {hasExisting
            ? "Press Enter to keep current key. Type 'none' or leave empty to disable."
            : "Press Enter to save (optional)."}
        </Text>
      </Box>
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
  reconfigure = false,
): PromptStep | null {
  if (reconfigure) {
    return "provider";
  }

  if (process.env[OPENWIKI_PROVIDER_ENV_KEY] === undefined) {
    return "provider";
  }

  if (provider === "custom" && !process.env.OPENWIKI_CUSTOM_BASE_URL) {
    return "custom-base-url";
  }

  if (!process.env[getProviderApiKeyEnvKey(provider)]) {
    return "api-key";
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
  reconfigure = false,
): PromptStep | null {
  if (
    provider === "custom" &&
    (reconfigure || !process.env.OPENWIKI_CUSTOM_BASE_URL)
  ) {
    return "custom-base-url";
  }

  if (reconfigure || !process.env[getProviderApiKeyEnvKey(provider)]) {
    return "api-key";
  }

  return getNextStepAfterApiKey(provider, modelIdOverride, reconfigure);
}

function getNextStepAfterCustomBaseUrl(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  reconfigure = false,
): PromptStep | null {
  if (reconfigure || !process.env[getProviderApiKeyEnvKey(provider)]) {
    return "api-key";
  }

  return getNextStepAfterApiKey(provider, modelIdOverride, reconfigure);
}

function getNextStepAfterApiKey(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  reconfigure = false,
): PromptStep | null {
  if (
    reconfigure ||
    (modelIdOverride === null &&
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined)
  ) {
    return "model";
  }

  if (reconfigure || process.env.LANGSMITH_API_KEY === undefined) {
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
  return provider === "baseten" ||
    provider === "fireworks" ||
    provider === "custom"
    ? "a"
    : "an";
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
