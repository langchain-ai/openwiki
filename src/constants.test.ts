import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_CONFIGS,
  isValidModelId,
  OPENROUTER_FALLBACK_MODEL_IDS,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  type OpenWikiProvider,
} from "./constants.js";

test("all model IDs in PROVIDER_CONFIGS are valid", () => {
  for (const [provider, config] of Object.entries(PROVIDER_CONFIGS)) {
    for (const option of config.modelOptions) {
      assert.ok(
        isValidModelId(option.id),
        `Model ID "${option.id}" in provider "${provider}" is not valid according to isValidModelId`,
      );
    }
  }
});

test("no duplicate model IDs within a provider", () => {
  for (const [provider, config] of Object.entries(PROVIDER_CONFIGS)) {
    const ids = config.modelOptions.map((opt) => opt.id);
    const uniqueIds = new Set(ids);
    assert.equal(
      ids.length,
      uniqueIds.size,
      `Duplicate model IDs found in provider "${provider}": ${JSON.stringify(ids)}`,
    );
  }
});

test("model ID consistency across providers (e.g. OpenRouter vs dedicated providers)", () => {
  // If an OpenRouter model ID is prefixed with a known provider name (e.g. "anthropic/claude-sonnet-5"),
  // the suffix must exist in that provider's own config.
  const openrouterConfig = PROVIDER_CONFIGS.openrouter;
  assert.ok(openrouterConfig, "OpenRouter provider configuration must exist");

  for (const option of openrouterConfig.modelOptions) {
    const parts = option.id.split("/");
    if (parts.length > 1) {
      const prefix = parts[0] as OpenWikiProvider;
      const suffix = parts.slice(1).join("/");

      // Only validate if the prefix is a known provider and not openrouter itself
      if (prefix in PROVIDER_CONFIGS && prefix !== "openrouter") {
        const targetProviderConfig = PROVIDER_CONFIGS[prefix];
        const targetIds = targetProviderConfig.modelOptions.map(
          (opt) => opt.id,
        );
        assert.ok(
          targetIds.includes(suffix),
          `OpenRouter model ID "${option.id}" is inconsistent: suffix "${suffix}" does not exist in provider "${prefix}" config model list (${JSON.stringify(targetIds)})`,
        );
      }
    }
  }
});

test("OPENROUTER_FALLBACK_MODEL_IDS contains valid and existing openrouter model IDs", () => {
  const openrouterConfig = PROVIDER_CONFIGS.openrouter;
  const openrouterIds = openrouterConfig.modelOptions.map((opt) => opt.id);

  for (const fallbackId of OPENROUTER_FALLBACK_MODEL_IDS) {
    assert.ok(
      isValidModelId(fallbackId),
      `Fallback model ID "${fallbackId}" is invalid`,
    );
    assert.ok(
      openrouterIds.includes(fallbackId),
      `Fallback model ID "${fallbackId}" is not present in OpenRouter model list`,
    );
  }
});

test("DEFAULT_MODEL_ID is valid and exists in default provider config", () => {
  assert.ok(
    isValidModelId(DEFAULT_MODEL_ID),
    `Default model ID "${DEFAULT_MODEL_ID}" is invalid`,
  );
  const defaultProviderConfig = PROVIDER_CONFIGS[DEFAULT_PROVIDER];
  const defaultProviderIds = defaultProviderConfig.modelOptions.map(
    (opt) => opt.id,
  );
  assert.ok(
    defaultProviderIds.includes(DEFAULT_MODEL_ID),
    `Default model ID "${DEFAULT_MODEL_ID}" is not present in default provider "${DEFAULT_PROVIDER}" model list`,
  );
});
