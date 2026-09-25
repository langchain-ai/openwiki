import type { Key } from "ink";
import {
  getProviderModelOptions,
  SELECTABLE_OPENWIKI_PROVIDERS,
  type OpenWikiProvider,
} from "../../config/constants.js";
import { getReasoningCapability } from "../../config/reasoning.js";
import type {
  ChatInputMenuState,
  ModelMenuOption,
  ReasoningEffortMenuOption,
  SlashCommandOption,
} from "./types.js";

/**
 * The slash commands shown in the command menu, in display order.
 */
export const slashCommandOptions: SlashCommandOption[] = [
  {
    description: "Switch the model provider",
    id: "provider",
    label: "/provider",
  },
  {
    description: "Switch the current provider model",
    id: "model",
    label: "/model",
  },
  {
    description: "Set reasoning effort for the current model",
    id: "effort",
    label: "/effort",
  },
  {
    description: "Set the API key for the current provider",
    id: "api-key",
    label: "/api-key",
  },
  {
    description: "Set or clear the LangSmith API key",
    id: "langsmith-key",
    label: "/langsmith-key",
  },
  {
    description: "Run an initial OpenWiki documentation pass",
    id: "init",
    label: "/init",
  },
  {
    description: "Update existing OpenWiki documentation",
    id: "update",
    label: "/update",
  },
  {
    description: "Start a fresh thread and clear chat history",
    id: "clear",
    label: "/clear",
  },
  {
    description: "Show slash command help",
    id: "help",
    label: "/help",
  },
  {
    description: "Exit OpenWiki",
    id: "exit",
    label: "/exit",
  },
];

/**
 * Derives the menu that should be showing for the current input text: the
 * provider menu for `/provider`, the model menu for `/model`, the command menu
 * for any other `/`-prefixed input, or no menu otherwise. Preserves the
 * highlighted index when the same menu kind stays open.
 */
export function syncMenuStateForInput(
  input: string,
  currentState: ChatInputMenuState,
  currentModelId: string,
  currentProvider: OpenWikiProvider,
  currentReasoningEffort: string | null = null,
): ChatInputMenuState {
  if (input.startsWith("/provider")) {
    const selectedIndex =
      currentState.kind === "provider"
        ? currentState.selectedIndex
        : getCurrentProviderOptionIndex(currentProvider);

    return {
      kind: "provider",
      selectedIndex: clampMenuIndex(
        selectedIndex,
        SELECTABLE_OPENWIKI_PROVIDERS.length,
      ),
    };
  }

  if (input.startsWith("/model")) {
    const selectedIndex =
      currentState.kind === "model"
        ? currentState.selectedIndex
        : getCurrentModelOptionIndex(currentModelId, currentProvider);

    return {
      kind: "model",
      selectedIndex: clampMenuIndex(
        selectedIndex,
        getModelMenuOptions(currentModelId, currentProvider).length,
      ),
    };
  }

  if (input.startsWith("/effort")) {
    const effortOptions = getReasoningEffortMenuOptions(
      currentProvider,
      currentModelId,
    );
    if (effortOptions.length === 0) {
      return { kind: "none" };
    }

    const selectedIndex =
      currentState.kind === "effort"
        ? currentState.selectedIndex
        : getCurrentReasoningEffortOptionIndex(
            currentProvider,
            currentModelId,
            currentReasoningEffort,
          );

    return {
      kind: "effort",
      selectedIndex: clampMenuIndex(selectedIndex, effortOptions.length),
    };
  }

  if (input.startsWith("/")) {
    const selectedIndex =
      currentState.kind === "commands"
        ? currentState.selectedIndex
        : getCommandOptionIndex(input);

    return {
      kind: "commands",
      selectedIndex: clampMenuIndex(selectedIndex, slashCommandOptions.length),
    };
  }

  return { kind: "none" };
}

/**
 * Moves the highlighted item within the active menu by `offset`, wrapping
 * around the ends. Returns the state unchanged when no menu is open.
 */
export function moveMenuSelection(
  menuState: ChatInputMenuState,
  offset: number,
  currentModelId: string,
  currentProvider: OpenWikiProvider,
): ChatInputMenuState {
  if (menuState.kind === "none") {
    return menuState;
  }

  const itemCount =
    menuState.kind === "model"
      ? getModelMenuOptions(currentModelId, currentProvider).length
      : menuState.kind === "effort"
        ? getReasoningEffortMenuOptions(currentProvider, currentModelId).length
        : menuState.kind === "provider"
          ? SELECTABLE_OPENWIKI_PROVIDERS.length
          : slashCommandOptions.length;

  return {
    ...menuState,
    selectedIndex: wrapMenuIndex(menuState.selectedIndex + offset, itemCount),
  };
}

/**
 * Finds the first command whose label the typed input is a prefix of, falling
 * back to the first command when none match.
 */
export function getCommandOptionIndex(input: string): number {
  const matchingIndex = slashCommandOptions.findIndex((option) =>
    option.label.startsWith(input),
  );

  return matchingIndex === -1 ? 0 : matchingIndex;
}

/**
 * Finds the model-menu row for the currently selected model, falling back to
 * the first row when the current model is not in the list.
 */
export function getCurrentModelOptionIndex(
  currentModelId: string,
  currentProvider: OpenWikiProvider,
): number {
  const matchingIndex = getModelMenuOptions(
    currentModelId,
    currentProvider,
  ).findIndex(
    (option) => option.kind === "model" && option.modelId === currentModelId,
  );

  return matchingIndex === -1 ? 0 : matchingIndex;
}

/**
 * Finds the provider-menu row for the current provider, falling back to the
 * first row when it is not selectable.
 */
export function getCurrentProviderOptionIndex(
  currentProvider: OpenWikiProvider,
): number {
  const matchingIndex = SELECTABLE_OPENWIKI_PROVIDERS.findIndex(
    (provider) => provider === currentProvider,
  );

  return matchingIndex === -1 ? 0 : matchingIndex;
}

/**
 * Builds the model-menu rows for a provider: the current model plus the
 * provider's preset models (deduped, current first), each labeled with its
 * preset name when known, followed by a "Custom model ID" row.
 */
export function getModelMenuOptions(
  currentModelId: string,
  currentProvider: OpenWikiProvider,
): ModelMenuOption[] {
  const modelIds = Array.from(
    new Set(
      [
        currentModelId,
        ...getProviderModelOptions(currentProvider).map((model) => model.id),
      ].filter(Boolean),
    ),
  );

  return [
    ...modelIds.map((modelId) => {
      const preset = getProviderModelOptions(currentProvider).find(
        (model) => model.id === modelId,
      );

      return {
        kind: "model" as const,
        label: preset ? `${preset.label} ${modelId}` : modelId,
        modelId,
      };
    }),
    {
      kind: "custom" as const,
      label: "Custom model ID",
    },
  ];
}

/**
 * Builds the capability-gated reasoning-effort rows for a provider and model.
 * Unsupported combinations return no rows, so callers can show an explanation
 * instead of offering a value that would fail before a request is sent.
 */
export function getReasoningEffortMenuOptions(
  provider: OpenWikiProvider,
  modelId: string,
): ReasoningEffortMenuOption[] {
  const capability = getReasoningCapability(provider, modelId);

  if (!capability) {
    return [];
  }

  return [
    { kind: "default", label: "Provider default" },
    ...capability.values.map((effort) => ({
      effort,
      kind: "effort" as const,
      label: effort,
    })),
  ];
}

/** Finds the selected reasoning-effort row, falling back to provider default. */
export function getCurrentReasoningEffortOptionIndex(
  provider: OpenWikiProvider,
  modelId: string,
  currentReasoningEffort: string | null,
): number {
  const options = getReasoningEffortMenuOptions(provider, modelId);
  const selectedIndex = options.findIndex(
    (option) =>
      (option.kind === "default" && currentReasoningEffort === null) ||
      (option.kind === "effort" && option.effort === currentReasoningEffort),
  );

  return selectedIndex === -1 ? 0 : selectedIndex;
}

/**
 * Parses a submitted input line into a matching slash command and its trailing
 * arguments, or returns null when the first token is not a known command.
 */
export function parseSlashInput(
  input: string,
): { args: string; option: SlashCommandOption } | null {
  const trimmedInput = input.trim();
  const [commandName = "", ...args] = trimmedInput.split(/\s+/u);
  const option = slashCommandOptions.find(
    (commandOption) => commandOption.label === commandName,
  );

  return option ? { args: args.join(" "), option } : null;
}

/**
 * Reports whether a keystroke is an up-arrow (menu previous), from either the
 * parsed `key` flag or a raw ANSI up-arrow sequence.
 */
export function isMenuUpInput(inputValue: string, key: Key): boolean {
  return key.upArrow || inputValue === "\u001b[A";
}

/**
 * Reports whether a keystroke is a down-arrow (menu next), from either the
 * parsed `key` flag or a raw ANSI down-arrow sequence.
 */
export function isMenuDownInput(inputValue: string, key: Key): boolean {
  return key.downArrow || inputValue === "\u001b[B";
}

/**
 * Clamps a menu index into `[0, itemCount - 1]` (or 0 when the menu is empty).
 */
export function clampMenuIndex(index: number, itemCount: number): number {
  return Math.max(0, Math.min(Math.max(0, itemCount - 1), index));
}

/**
 * Wraps a menu index into `[0, itemCount - 1]`, cycling past either end.
 */
export function wrapMenuIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) {
    return 0;
  }

  return ((index % itemCount) + itemCount) % itemCount;
}
