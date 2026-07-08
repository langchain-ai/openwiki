import { describe, expect, test, vi } from "vitest";
import {
  getProviderApiKeyEnvKey,
  getProviderLabel,
  isValidProvider,
  normalizeProvider,
  providerUsesApiKey,
  providerUsesCodexOAuth,
  resolveConfiguredProvider,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "../src/constants.ts";
import { needsCredentialSetup } from "../src/credentials.tsx";

describe("codex-oauth provider integration", () => {
  test("normalizes and resolves codex-oauth as a first-class provider", () => {
    expect(normalizeProvider(" CODEX-OAUTH ")).toBe("codex-oauth");
    expect(isValidProvider("codex-oauth")).toBe(true);
    expect(resolveConfiguredProvider({ OPENWIKI_PROVIDER: "codex-oauth" })).toBe(
      "codex-oauth",
    );
  });

  test("exposes Codex OAuth as a selectable provider with managed credentials", () => {
    expect(SELECTABLE_OPENWIKI_PROVIDERS).toContain("codex-oauth");
    expect(getProviderLabel("codex-oauth")).toBe("Codex OAuth");
    expect(getProviderApiKeyEnvKey("codex-oauth")).toBeNull();
    expect(providerUsesApiKey("codex-oauth")).toBe(false);
    expect(providerUsesCodexOAuth("codex-oauth")).toBe(true);
  });

  test("skips API-key credential setup for codex-oauth", () => {
    vi.stubEnv("OPENWIKI_PROVIDER", "codex-oauth");
    vi.stubEnv("OPENWIKI_MODEL_ID", "gpt-5.5");
    vi.stubEnv("LANGSMITH_API_KEY", "");

    try {
      expect(needsCredentialSetup()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
