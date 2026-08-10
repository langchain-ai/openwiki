import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { OpenWikiCommand } from "../../agent/types.js";
import {
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderCredentialHint,
  getProviderLabel,
  getProviderModelOptions,
  getProviderProjectEnvKey,
  isValidModelId,
  normalizeModelId,
  normalizeProvider,
  providerUsesAwsSdkCredentials,
  SELECTABLE_OPENWIKI_PROVIDERS,
  type OpenWikiProvider,
} from "../../config/constants.js";
import { saveOpenWikiEnv } from "../../config/env.js";
import {
  applyRawInputValue,
  deleteAtInputCursor,
  deleteBeforeInputCursor,
  isEscapeInput,
  isRawBackspaceInput,
  moveInputCursor,
} from "../input/cursor.js";
import {
  getCurrentModelOptionIndex,
  getCurrentProviderOptionIndex,
  getModelMenuOptions,
  isMenuDownInput,
  isMenuUpInput,
  moveMenuSelection,
  parseSlashInput,
  slashCommandOptions,
  syncMenuStateForInput,
} from "../input/menu.js";
import { formatSecretInputSummary } from "../input/secret.js";
import type {
  ChatInputMenuState,
  ChatInputState,
  SecretInputMode,
  SlashCommandOption,
} from "../input/types.js";
import { formatCwd } from "../format.js";
import { InputCursor, MenuRow, PromptBlock } from "./primitives.js";
import { RunLogLine } from "./run-view.js";
import type { CompletedRun } from "./types.js";

/**
 * The scrollback of completed runs: each run's prompt, status line, and log.
 */
export function ChatHistory({ runs }: { runs: CompletedRun[] }) {
  if (runs.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {runs.map((run) => (
        <Box flexDirection="column" key={run.id} marginBottom={1}>
          {run.message ? <PromptBlock message={run.message} /> : null}
          <Text>
            <Text color="green">* </Text>
            <Text bold>Complete</Text>{" "}
            <Text color="gray">
              openwiki {run.command} - {run.result.model}
            </Text>
          </Text>
          <Box flexDirection="column" marginLeft={2} marginTop={1}>
            {run.log.length > 0 ? (
              run.log.map((item) => <RunLogLine item={item} key={item.id} />)
            ) : (
              <Text color="gray">No assistant output captured.</Text>
            )}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/**
 * Props for the interactive chat prompt.
 */
interface ChatInputProps {
  currentModelId: string;
  currentProvider: OpenWikiProvider;
  onClear: () => void;
  onCommandRun: (
    command: Extract<OpenWikiCommand, "init" | "update">,
    message: string | null,
  ) => void;
  onModelSelect: (modelId: string) => Promise<void>;
  onProviderSelect: (provider: OpenWikiProvider) => Promise<void>;
  onSubmit: (message: string) => void;
}

/**
 * The interactive follow-up prompt: handles keystrokes, the slash-command menu,
 * and masked credential entry. Secret values are never echoed; only a masked
 * length summary is shown, and keys are persisted via saveOpenWikiEnv.
 */
export function ChatInput({
  currentModelId,
  currentProvider,
  onClear,
  onCommandRun,
  onModelSelect,
  onProviderSelect,
  onSubmit,
}: ChatInputProps) {
  const [inputState, setInputState] = useState<ChatInputState>({
    cursorPosition: 0,
    value: "",
  });
  const [menuState, setMenuState] = useState<ChatInputMenuState>({
    kind: "none",
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [secretInputMode, setSecretInputMode] =
    useState<SecretInputMode | null>(null);
  const input = inputState.value;
  const cursorPosition = inputState.cursorPosition;

  useEffect(() => {
    if (secretInputMode !== null) {
      return;
    }

    setMenuState((currentState) =>
      syncMenuStateForInput(
        input,
        currentState,
        currentModelId,
        currentProvider,
      ),
    );
  }, [currentModelId, currentProvider, input, secretInputMode]);

  useInput((inputValue, key) => {
    if (isSaving) {
      return;
    }

    if (secretInputMode !== null) {
      if (isEscapeInput(inputValue, key)) {
        resetInput();
        setSecretInputMode(null);
        setNotice("Credential update canceled.");
        return;
      }

      if (key.return) {
        void saveSecretInput();
        return;
      }

      if (key.backspace || isRawBackspaceInput(inputValue)) {
        setInputState(deleteBeforeInputCursor);
        return;
      }

      if (key.delete) {
        setInputState(
          inputValue.length === 0
            ? deleteBeforeInputCursor
            : deleteAtInputCursor,
        );
        return;
      }

      if (inputValue && !key.ctrl && !key.meta) {
        setError(null);
        setNotice(null);
        setInputState((state) => applyRawInputValue(state, inputValue));
      }

      return;
    }

    if (isMenuUpInput(inputValue, key) && menuState.kind !== "none") {
      setMenuState((state) =>
        moveMenuSelection(state, -1, currentModelId, currentProvider),
      );
      return;
    }

    if (isMenuDownInput(inputValue, key) && menuState.kind !== "none") {
      setMenuState((state) =>
        moveMenuSelection(state, 1, currentModelId, currentProvider),
      );
      return;
    }

    if (key.return) {
      void submitInput();
      return;
    }

    if (isEscapeInput(inputValue, key) && menuState.kind !== "none") {
      resetInput();
      return;
    }

    if (key.leftArrow) {
      setInputState((state) => moveInputCursor(state, -1));
      return;
    }

    if (key.rightArrow) {
      setInputState((state) => moveInputCursor(state, 1));
      return;
    }

    if ((key.ctrl && inputValue === "a") || inputValue === "\u0001") {
      setInputState((state) => ({
        ...state,
        cursorPosition: 0,
      }));
      return;
    }

    if ((key.ctrl && inputValue === "e") || inputValue === "\u0005") {
      setInputState((state) => ({
        ...state,
        cursorPosition: state.value.length,
      }));
      return;
    }

    if (key.backspace || isRawBackspaceInput(inputValue)) {
      setInputState(deleteBeforeInputCursor);
      return;
    }

    if (key.delete) {
      setInputState(
        inputValue.length === 0 ? deleteBeforeInputCursor : deleteAtInputCursor,
      );
      return;
    }

    if (inputValue && !key.ctrl && !key.meta) {
      setError(null);
      setNotice(null);
      setInputState((state) => applyRawInputValue(state, inputValue));
    }
  });

  async function submitInput() {
    const message = input.trim();

    if (message.length === 0) {
      setError("Enter a follow-up message.");
      return;
    }

    if (message.startsWith("/")) {
      await submitSlashInput(message);
      return;
    }

    resetInput();
    onSubmit(message);
  }

  async function submitSlashInput(message: string) {
    if (message === "/" && menuState.kind === "commands") {
      await runSlashCommand(slashCommandOptions[menuState.selectedIndex]);
      return;
    }

    if (message === "/model" && menuState.kind === "model") {
      await selectModelMenuOption(menuState.selectedIndex);
      return;
    }

    if (message === "/provider" && menuState.kind === "provider") {
      await selectProviderMenuOption(menuState.selectedIndex);
      return;
    }

    const parsedCommand = parseSlashInput(message);

    if (parsedCommand === null) {
      setError(`Unknown command: ${message}`);
      return;
    }

    await runSlashCommand(
      parsedCommand.option,
      parsedCommand.args.length > 0 ? parsedCommand.args : null,
    );
  }

  async function runSlashCommand(
    option: SlashCommandOption | undefined,
    args: string | null = null,
  ) {
    if (!option) {
      setError("Select a slash command.");
      return;
    }

    if (option.id === "model") {
      if (args && args.length > 0) {
        await saveModelSelection(args);
        return;
      }

      setError(null);
      setNotice("Choose a model, or type /model <model-id>.");
      setInputValue("/model");
      setMenuState({
        kind: "model",
        selectedIndex: getCurrentModelOptionIndex(
          currentModelId,
          currentProvider,
        ),
      });
      return;
    }

    if (option.id === "provider") {
      if (args && args.length > 0) {
        await saveProviderSelection(args);
        return;
      }

      setError(null);
      setNotice("Choose a provider, or type /provider <provider-id>.");
      setInputValue("/provider");
      setMenuState({
        kind: "provider",
        selectedIndex: getCurrentProviderOptionIndex(currentProvider),
      });
      return;
    }

    if (option.id === "api-key") {
      if (args && args.length > 0) {
        setError(
          "Use the masked prompt for API keys; do not pass keys inline.",
        );
        return;
      }

      if (providerUsesAwsSdkCredentials(currentProvider)) {
        setError(
          `${getProviderLabel(currentProvider)} uses the AWS SDK credential chain; /api-key cannot safely configure an access-key pair. ${getProviderCredentialHint(currentProvider) ?? ""} Legacy BEDROCK_AWS_ACCESS_KEY_ID and BEDROCK_AWS_SECRET_ACCESS_KEY values must be configured or removed together in the shell and ~/.openwiki/.env.`.trim(),
        );
        return;
      }

      const apiKeyEnvKey = getProviderApiKeyEnvKey(currentProvider);

      if (!apiKeyEnvKey) {
        const hint = getProviderCredentialHint(currentProvider);

        setError(
          `${getProviderLabel(currentProvider)} does not use an API key.${
            hint ? ` ${hint}` : ""
          }`,
        );
        return;
      }

      setError(null);
      setNotice(`Paste your ${getProviderLabel(currentProvider)} API key.`);
      setSecretInputMode({
        envKey: apiKeyEnvKey,
        kind: "api-key",
        label: `${getProviderLabel(currentProvider)} API key`,
        provider: currentProvider,
      });
      setInputState({ cursorPosition: 0, value: "" });
      setMenuState({ kind: "none" });
      return;
    }

    if (option.id === "langsmith-key") {
      if (args && args.length > 0) {
        setError(
          "Use the masked prompt for LangSmith keys; do not pass keys inline.",
        );
        return;
      }

      setError(null);
      setNotice("Paste your LangSmith API key, or press Enter empty to clear.");
      setSecretInputMode({
        envKey: "LANGSMITH_API_KEY",
        kind: "langsmith-key",
        label: "LangSmith API key",
      });
      setInputState({ cursorPosition: 0, value: "" });
      setMenuState({ kind: "none" });
      return;
    }

    if (option.id === "init" || option.id === "update") {
      resetInput();
      onCommandRun(option.id, args);
      return;
    }

    if (option.id === "clear") {
      resetInput();
      onClear();
      setNotice("Started a new chat thread.");
      return;
    }

    if (option.id === "help") {
      resetInput();
      setNotice(
        "Slash commands: /provider, /model, /api-key, /langsmith-key, /init, /update, /clear, /help, /exit. Use arrows to select.",
      );
      return;
    }

    resetInput();
    onSubmit("/exit");
  }

  async function selectModelMenuOption(selectedIndex: number) {
    const option = getModelMenuOptions(currentModelId, currentProvider)[
      selectedIndex
    ];

    if (!option) {
      setError("Select a model.");
      return;
    }

    if (option.kind === "custom") {
      setError(null);
      setNotice("Type a custom model ID after /model.");
      setInputValue("/model ");
      return;
    }

    await saveModelSelection(option.modelId);
  }

  async function saveModelSelection(rawModelId: string) {
    const modelId = normalizeModelId(rawModelId);

    if (!isValidModelId(modelId)) {
      setError("Enter a valid model ID.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      await onModelSelect(modelId);
      resetInput();
      setNotice(`Model switched to ${modelId}.`);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save model selection.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function selectProviderMenuOption(selectedIndex: number) {
    const provider = SELECTABLE_OPENWIKI_PROVIDERS[selectedIndex];

    if (!provider) {
      setError("Select a provider.");
      return;
    }

    await saveProviderSelection(provider);
  }

  async function saveProviderSelection(rawProvider: string) {
    const provider = normalizeProvider(rawProvider);

    if (provider === null) {
      setError(
        `Enter a valid provider: ${SELECTABLE_OPENWIKI_PROVIDERS.join(", ")}.`,
      );
      return;
    }

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      await onProviderSelect(provider);
      resetInput();
      const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);
      const requirement = providerUsesAwsSdkCredentials(provider)
        ? (getProviderCredentialHint(provider) ??
          "Configure AWS SDK credentials.")
        : apiKeyEnvKey
          ? `Ensure ${apiKeyEnvKey} is set.`
          : `Ensure ${getProviderProjectEnvKey(provider)} is set. ${getProviderCredentialHint(provider) ?? ""}`.trim();
      const modelNotice =
        getProviderModelOptions(provider).length > 0
          ? ` with model ${getDefaultModelId(provider)}`
          : ". Set a model with /model";

      setNotice(
        `Provider switched to ${getProviderLabel(provider)}${modelNotice}. ${requirement}`,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save provider selection.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function saveSecretInput() {
    if (secretInputMode === null) {
      return;
    }

    const nextValue = input.trim();
    if (secretInputMode.kind === "api-key" && nextValue.length === 0) {
      setError(`${secretInputMode.envKey} is required.`);
      return;
    }

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      if (secretInputMode.kind === "langsmith-key") {
        await saveOpenWikiEnv({
          LANGCHAIN_PROJECT: nextValue.length > 0 ? "openwiki" : "",
          LANGCHAIN_TRACING_V2: nextValue.length > 0 ? "true" : "false",
          LANGSMITH_API_KEY: nextValue,
        });
      } else {
        await saveOpenWikiEnv({
          [secretInputMode.envKey]: nextValue,
        });
      }

      const savedLabel = secretInputMode.label;
      resetInput();
      setSecretInputMode(null);
      setNotice(`${savedLabel} saved.`);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save credential.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  function resetInput() {
    setInputState({ cursorPosition: 0, value: "" });
    setMenuState({ kind: "none" });
    setError(null);
  }

  function setInputValue(value: string) {
    setInputState({
      cursorPosition: value.length,
      value,
    });
  }

  const beforeCursor = input.slice(0, cursorPosition);
  const afterCursor = input.slice(cursorPosition);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="single" borderColor="blue" paddingX={1}>
        <Text>
          <Text color="blue">{">"}</Text>{" "}
          {secretInputMode !== null ? (
            <>
              <Text color="gray">{secretInputMode.envKey}=</Text>
              <Text color="yellow">{formatSecretInputSummary(input)}</Text>
            </>
          ) : input.length > 0 ? (
            <>
              {beforeCursor}
              <InputCursor />
              {afterCursor}
            </>
          ) : (
            <>
              <InputCursor />
              <Text color="gray"> Ask a follow-up...</Text>
            </>
          )}
        </Text>
      </Box>
      <Text>
        <Text color="gray">
          {secretInputMode !== null
            ? "enter to save - esc to cancel - input is masked"
            : `enter to send - / for commands - /exit to quit - cwd ${formatCwd(
                process.cwd(),
              )}`}
        </Text>
      </Text>
      {secretInputMode !== null ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">{secretInputMode.label}</Text>
          <Text>
            Saving to <Text color="cyan">{secretInputMode.envKey}</Text>
          </Text>
          {secretInputMode.kind === "langsmith-key" ? (
            <Text color="gray">Press Enter empty to clear LangSmith.</Text>
          ) : null}
        </Box>
      ) : menuState.kind !== "none" ? (
        <SlashMenu
          currentModelId={currentModelId}
          currentProvider={currentProvider}
          input={input}
          menuState={menuState}
        />
      ) : null}
      {notice ? <Text color="green">{notice}</Text> : null}
      {isSaving ? <Text color="gray">Saving selection...</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}

/**
 * The slash-command popup: renders the model, provider, or command menu with
 * the current selection highlighted.
 */
export function SlashMenu({
  currentModelId,
  currentProvider,
  input,
  menuState,
}: {
  currentModelId: string;
  currentProvider: OpenWikiProvider;
  input: string;
  menuState: Exclude<ChatInputMenuState, { kind: "none" }>;
}) {
  if (menuState.kind === "model") {
    const modelOptions = getModelMenuOptions(currentModelId, currentProvider);

    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">Models for {getProviderLabel(currentProvider)}</Text>
        {modelOptions.map((option, index) => (
          <MenuRow
            description={
              option.kind === "model" && option.modelId === currentModelId
                ? "current"
                : option.kind === "custom"
                  ? "type /model <model-id>"
                  : ""
            }
            isSelected={index === menuState.selectedIndex}
            key={option.label}
            label={option.label}
          />
        ))}
        {input.startsWith("/model ") ? (
          <Text color="gray">Press enter to save the custom model ID.</Text>
        ) : (
          <Text color="gray">Use arrows, enter to select, esc to cancel.</Text>
        )}
      </Box>
    );
  }

  if (menuState.kind === "provider") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">Providers</Text>
        {SELECTABLE_OPENWIKI_PROVIDERS.map((provider, index) => (
          <MenuRow
            description={
              provider === currentProvider
                ? "current"
                : `default model ${getDefaultModelId(provider)}`
            }
            isSelected={index === menuState.selectedIndex}
            key={provider}
            label={getProviderLabel(provider)}
          />
        ))}
        <Text color="gray">Use arrows, enter to select, esc to cancel.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">Commands</Text>
      {slashCommandOptions.map((option, index) => (
        <MenuRow
          description={option.description}
          isSelected={index === menuState.selectedIndex}
          key={option.id}
          label={option.label}
        />
      ))}
      <Text color="gray">Use arrows, enter to select, esc to cancel.</Text>
    </Box>
  );
}
