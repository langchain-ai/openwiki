import { hasValidConfiguredProvider } from "../config/credentials.js";
import { DEFAULT_PROVIDER, OPENWIKI_MODEL_ID_ENV_KEY } from "../constants.js";
import {
  getDefaultModelId,
  getProviderLabel,
  getProviderModelOptions,
  isValidModelId,
  normalizeModelId,
  type OpenWikiProvider,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "./config.js";

/**
 * One entry in the model-selection menu: either a curated preset the registry
 * offers for the provider, or the sentinel that lets the user type a custom id.
 */
export type ModelSelectionOption =
  | {
      /**
       * The model id sent to the provider when this preset is chosen.
       */
      id: string;

      /**
       * Discriminant marking this as a curated preset.
       */
      kind: "preset";

      /**
       * Human-readable menu label for the preset.
       */
      label: string;
    }
  | {
      /**
       * Discriminant marking the "enter a custom model id" menu entry.
       */
      kind: "custom";
    };

/**
 * Human-readable provider status for the setup summary: the configured
 * provider's label, or the default provider's label when none is configured.
 */
export function getProviderSetupDetail(provider: OpenWikiProvider): string {
  if (hasValidConfiguredProvider()) {
    return getProviderLabel(provider);
  }

  return `default ${getProviderLabel(DEFAULT_PROVIDER)}`;
}

/**
 * Human-readable model status for the setup summary: a per-run override, the
 * stored model id, or the provider's default model when neither is set.
 */
export function getModelSetupDetail(
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

/**
 * The model-selection menu for a provider: its curated presets followed by the
 * custom-entry sentinel.
 */
export function getModelSelectionOptions(
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

/**
 * True when a provider offers no curated presets, so the wizard should open
 * straight into the custom-model-id input instead of a menu.
 */
export function shouldStartWithCustomModelInput(
  provider: OpenWikiProvider,
): boolean {
  return getProviderModelOptions(provider).length === 0;
}

/**
 * Resolves the model id the user settled on: the chosen preset (or the `custom`
 * sentinel) from the menu, or the validated custom input. `null` when the
 * selection is out of range or the typed id is invalid.
 */
export function getSelectedModelId(
  provider: OpenWikiProvider,
  selectedIndex: number,
  input: string,
  isCustomInput: boolean,
): string | null {
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

/**
 * The index of a provider within the selectable-provider menu, clamped to 0
 * when the provider is not selectable.
 */
export function getProviderSelectionIndex(provider: OpenWikiProvider): number {
  const selectedIndex = SELECTABLE_OPENWIKI_PROVIDERS.findIndex(
    (providerOption) => providerOption === provider,
  );

  return selectedIndex === -1 ? 0 : selectedIndex;
}

/**
 * The index of a stored model id within the provider's selection menu, clamped
 * to 0 when the id is not one of the presets.
 */
export function getModelSelectionIndex(
  provider: OpenWikiProvider,
  selectedModelId: string,
): number {
  const selectedIndex = getModelSelectionOptions(provider).findIndex(
    (option) => option.kind === "preset" && option.id === selectedModelId,
  );

  return selectedIndex === -1 ? 0 : selectedIndex;
}

/**
 * The indefinite article ("a"/"an") that reads correctly before a provider's
 * spoken name, for grammatical setup prompts.
 */
export function getProviderArticle(provider: OpenWikiProvider): "a" | "an" {
  return provider === "baseten" || provider === "fireworks" ? "a" : "an";
}
