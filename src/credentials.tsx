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
  // When true, walk every step even if values already exist, so the user can
  // change settings. Empty input on the API key / LangSmith steps means "keep
  // the current value" so existing credentials are never nulled out.
  reconfigure?: boolean;
  onComplete: (result: InitSetupResult) => void;
  onError: (message: string) => void;
};

type PromptStep = "api-key" | "langsmith" | "model" | "provider";

export function needsCredentialSetup(
  modelIdOverride: string | null = null,
): boolean {
  const provider = resolveConfiguredProvider();
  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);

  return (
    process.env[OPENWIKI_PROVIDER_ENV_KEY] === undefined ||
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
  const currentSavedModelId =
    modelIdOverride ?? process.env[OPENWIKI_MODEL_ID_ENV_KEY] ?? null;
  // Only surface the saved model as a "keep current" option for the provider it
  // belongs to; switching providers should fall back to that provider's default.
  const injectedModelIdFor = (p: OpenWikiProvider): string | null =>
    reconfigure && p === initialProvider ? currentSavedModelId : null;
  const [step, setStep] = useState<PromptStep | null>(null);
  const [provider, setProvider] = useState<OpenWikiProvider>(initialProvider);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [langSmithKey, setLangSmithKey] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [providerSelectionIndex, setProviderSelectionIndex] = useState(() =>
    getProviderSelectionIndex(initialProvider),
  );
  const [modelSelectionIndex, setModelSelectionIndex] = useState(() =>
    getModelSelectionIndex(
      initialProvider,
      currentSavedModelId ?? getDefaultModelId(initialProvider),
      injectedModelIdFor(initialProvider),
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
        currentSavedModelId ?? getDefaultModelId(initialProvider),
        injectedModelIdFor(initialProvider),
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
            getModelSelectionOptions(provider, injectedModelIdFor(provider))
              .length,
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

      const injectedModelId = injectedModelIdFor(selectedProvider);
      setProvider(selectedProvider);
      setProviderSelectionIndex(getProviderSelectionIndex(selectedProvider));
      setModelSelectionIndex(
        getModelSelectionIndex(
          selectedProvider,
          injectedModelId ?? getDefaultModelId(selectedProvider),
          injectedModelId,
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
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextProvider: selectedProvider,
      });
      return;
    }

    if (step === "api-key") {
      const trimmedInput = input.trim();
      const hasExistingKey = Boolean(
        process.env[getProviderApiKeyEnvKey(provider)],
      );

      // In reconfigure mode, an empty entry keeps the current key rather than
      // erroring — but only when there is a current key to keep (e.g. the user
      // did not just switch to a provider that has no saved key).
      if (trimmedInput.length === 0) {
        if (reconfigure && hasExistingKey) {
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
        injectedModelIdFor(provider),
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
        nextLangSmithKey: langSmithKey,
        nextModelId: selectedModelId,
        nextProvider: provider,
      });
      return;
    }

    if (step === "langsmith") {
      const trimmedInput = input.trim();
      // Fresh setup keeps its existing behavior (empty saves an empty value so
      // the optional step is not asked again). In reconfigure mode an empty
      // entry keeps the current LangSmith key instead of clearing it.
      const nextLangSmithKey =
        trimmedInput.length > 0 ? trimmedInput : reconfigure ? null : "";

      setLangSmithKey(nextLangSmithKey);
      setInput("");

      await completeSetup({
        nextApiKey: apiKey,
        nextLangSmithKey,
        nextModelId: modelId,
        nextProvider: provider,
      });
    }
  }

  type CompleteSetupOptions = {
    nextApiKey: string | null;
    nextLangSmithKey: string | null;
    nextModelId: string | null;
    nextProvider: OpenWikiProvider;
  };

  async function completeSetup({
    nextApiKey,
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

      if (nextModelId !== null) {
        updates[OPENWIKI_MODEL_ID_ENV_KEY] = nextModelId;
      }

      if (nextLangSmithKey !== null) {
        updates.LANGSMITH_API_KEY = nextLangSmithKey;

        if (nextLangSmithKey.length > 0) {
          updates.LANGCHAIN_PROJECT = "openwiki";
          updates.LANGCHAIN_TRACING_V2 = "true";
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
            injectedModelId={injectedModelIdFor(provider)}
            isCustomModelInput={isCustomModelInput}
            modelSelectionIndex={modelSelectionIndex}
            provider={provider}
            providerSelectionIndex={providerSelectionIndex}
            reconfigure={reconfigure}
            step={step}
          />
        ) : (
          <Text>Inspecting OpenWiki setup...</Text>
        )}
      </SetupPanel>

      {needsCredentialPrompt || reconfigure ? (
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
  injectedModelId: string | null;
  isCustomModelInput: boolean;
  modelSelectionIndex: number;
  provider: OpenWikiProvider;
  providerSelectionIndex: number;
  reconfigure: boolean;
  step: PromptStep;
};

function Prompt({
  input,
  injectedModelId,
  isCustomModelInput,
  modelSelectionIndex,
  provider,
  providerSelectionIndex,
  reconfigure,
  step,
}: PromptProps) {
  const canKeepCurrentKey =
    reconfigure && Boolean(process.env[getProviderApiKeyEnvKey(provider)]);
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
        <Text color="gray">
          {canKeepCurrentKey
            ? "Press Enter to keep the current key, or paste a new one."
            : "Press Enter to save it."}
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
        {getModelSelectionOptions(provider, injectedModelId).map(
          (option, index) => {
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
          },
        )}
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "langsmith") {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="gray">$</Text> LANGSMITH_API_KEY optional={" "}
          <Text color="yellow">{mask(input)}</Text>
        </Text>
        {reconfigure &&
        process.env.LANGSMITH_API_KEY !== undefined &&
        process.env.LANGSMITH_API_KEY.length > 0 ? (
          <Text color="gray">
            Press Enter to keep the current key, or paste a new one.
          </Text>
        ) : null}
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
  reconfigure: boolean,
): PromptStep | null {
  // Reconfigure always starts from the top and walks every step so the user
  // can change any setting; only-missing steps are for first-time setup.
  if (reconfigure) {
    return "provider";
  }

  if (process.env[OPENWIKI_PROVIDER_ENV_KEY] === undefined) {
    return "provider";
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
  reconfigure: boolean,
): PromptStep | null {
  if (reconfigure || !process.env[getProviderApiKeyEnvKey(provider)]) {
    return "api-key";
  }

  return getNextStepAfterApiKey(provider, modelIdOverride, reconfigure);
}

function getNextStepAfterApiKey(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  reconfigure: boolean,
): PromptStep | null {
  if (
    reconfigure ||
    (modelIdOverride === null &&
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined)
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
  currentModelId?: string | null,
): ModelSelectionOption[] {
  const presets = getProviderModelOptions(provider).map((model) => ({
    id: model.id,
    kind: "preset" as const,
    label: model.label,
  }));

  // Reconfigure passes the currently-saved model. When it is not one of the
  // provider presets (e.g. a custom model set via --modelId or /model), surface
  // it as a selectable option so pressing Enter keeps it instead of silently
  // switching to the first preset.
  const hasCurrent =
    currentModelId !== undefined &&
    currentModelId !== null &&
    currentModelId.length > 0 &&
    !presets.some((preset) => preset.id === currentModelId);

  return [
    ...(hasCurrent
      ? [{ id: currentModelId, kind: "preset" as const, label: "current" }]
      : []),
    ...presets,
    { kind: "custom" },
  ];
}

function getSelectedModelId(
  provider: OpenWikiProvider,
  selectedIndex: number,
  input: string,
  isCustomInput: boolean,
  currentModelId?: string | null,
): string | "custom" | null {
  if (!isCustomInput) {
    const selectedOption = getModelSelectionOptions(provider, currentModelId)[
      selectedIndex
    ];

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
  currentModelId?: string | null,
): number {
  const selectedIndex = getModelSelectionOptions(
    provider,
    currentModelId,
  ).findIndex(
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
