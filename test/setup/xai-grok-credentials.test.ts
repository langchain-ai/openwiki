import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getInitialStep,
  getNextStepAfterProvider,
  needsCredentialSetup,
  orderedSetupSteps,
} from "../../src/setup/credentials.tsx";

const MANAGED_KEYS = [
  "OPENWIKI_PROVIDER",
  "OPENWIKI_MODEL_ID",
  "LANGSMITH_API_KEY",
  "XAI_GROK_ACCESS_TOKEN",
  "XAI_GROK_REFRESH_TOKEN",
  "XAI_GROK_EXPIRES_AT",
] as const;

const FAR_FUTURE = String(Date.now() + 60 * 60 * 1000);
const PAST = String(Date.now() - 60 * 60 * 1000);

let snapshot: Record<string, string | undefined>;

function set(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function storeXaiGrokTokens(expiresAt: string = FAR_FUTURE): void {
  set("XAI_GROK_ACCESS_TOKEN", "access-token");
  set("XAI_GROK_REFRESH_TOKEN", "refresh-token");
  set("XAI_GROK_EXPIRES_AT", expiresAt);
}

beforeEach(() => {
  snapshot = {};
  for (const key of MANAGED_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    set(key, snapshot[key]);
  }
});

describe("xai-grok oauth credential step transitions", () => {
  test("routes to oauth-login when no token is stored", () => {
    set("OPENWIKI_PROVIDER", "xai-grok");

    expect(getInitialStep(null, "xai-grok")).toBe("oauth-login");
    expect(getNextStepAfterProvider("xai-grok", null)).toBe("oauth-login");
    expect(needsCredentialSetup(null)).toBe(true);
  });

  test("routes to oauth-login when the stored token is expired", () => {
    set("OPENWIKI_PROVIDER", "xai-grok");
    storeXaiGrokTokens(PAST);

    expect(getInitialStep(null, "xai-grok")).toBe("oauth-login");
    expect(needsCredentialSetup(null)).toBe(true);
  });

  test("routes to oauth-login when the stored token set is incomplete", () => {
    set("OPENWIKI_PROVIDER", "xai-grok");
    set("XAI_GROK_ACCESS_TOKEN", "access-token");
    set("XAI_GROK_EXPIRES_AT", FAR_FUTURE);

    expect(getInitialStep(null, "xai-grok")).toBe("oauth-login");
    expect(needsCredentialSetup(null)).toBe(true);
  });

  test("skips oauth-login when a valid token is stored", () => {
    set("OPENWIKI_PROVIDER", "xai-grok");
    storeXaiGrokTokens();

    expect(getInitialStep(null, "xai-grok")).toBe("model");
    expect(getNextStepAfterProvider("xai-grok", null)).toBe("model");
  });

  test("includes oauth-login in the setup spine", () => {
    expect(orderedSetupSteps("xai-grok", "code", false)).toEqual([
      "provider",
      "oauth-login",
      "model",
      "langsmith",
      "code-repo-confirm",
    ]);
  });
});
