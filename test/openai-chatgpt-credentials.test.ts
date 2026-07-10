import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  findNearestGitRepoRoot,
  getInitialStep,
  getNextStepAfterProvider,
  needsCredentialSetup,
} from "../src/credentials.tsx";

const MANAGED_KEYS = [
  "OPENWIKI_PROVIDER",
  "OPENWIKI_MODEL_ID",
  "LANGSMITH_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_CHATGPT_ACCESS_TOKEN",
  "OPENAI_CHATGPT_REFRESH_TOKEN",
  "OPENAI_CHATGPT_ACCOUNT_ID",
  "OPENAI_CHATGPT_EXPIRES_AT",
] as const;

const FAR_FUTURE = String(Date.now() + 60 * 60 * 1000);
const PAST = String(Date.now() - 60 * 60 * 1000);
const COMPLETE_ONBOARDING = {
  completedAt: "2026-01-01T00:00:00.000Z",
  modeId: "code",
  modeName: "Code",
  sourceInstances: [],
  sources: {},
  templateId: "code",
  templateName: "Code",
  version: 1 as const,
  wikiGoal: "Maintain a code wiki.",
};
const CODE_ONBOARDING_WITHOUT_SCHEDULE = {
  ...COMPLETE_ONBOARDING,
  completedAt: undefined,
};

let snapshot: Record<string, string | undefined>;

function set(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/** Stores a complete token set, as a real login would. */
function storeChatGptTokens(expiresAt: string = FAR_FUTURE): void {
  set("OPENAI_CHATGPT_ACCESS_TOKEN", "access-token");
  set("OPENAI_CHATGPT_REFRESH_TOKEN", "refresh-token");
  set("OPENAI_CHATGPT_ACCOUNT_ID", "acct_1");
  set("OPENAI_CHATGPT_EXPIRES_AT", expiresAt);
}

/** Configure a fully signed-in ChatGPT session with model + langsmith set. */
function configureValidChatGptSession(): void {
  set("OPENWIKI_PROVIDER", "openai-chatgpt");
  storeChatGptTokens();
  set("OPENWIKI_MODEL_ID", "gpt-5.5");
  set("LANGSMITH_API_KEY", "");
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

describe("oauth credential step transitions", () => {
  test("routes to oauth-login when no token is stored", () => {
    set("OPENWIKI_PROVIDER", "openai-chatgpt");

    expect(getInitialStep(null, "openai-chatgpt")).toBe("oauth-login");
    expect(getNextStepAfterProvider("openai-chatgpt", null)).toBe(
      "oauth-login",
    );
    expect(needsCredentialSetup(null)).toBe(true);
  });

  test("routes to oauth-login when the stored token is expired", () => {
    set("OPENWIKI_PROVIDER", "openai-chatgpt");
    storeChatGptTokens(PAST);

    expect(getInitialStep(null, "openai-chatgpt")).toBe("oauth-login");
    expect(needsCredentialSetup(null)).toBe(true);
  });

  test("routes to oauth-login when the stored token set is incomplete", () => {
    // An access token alone cannot call the Codex backend (no account id).
    set("OPENWIKI_PROVIDER", "openai-chatgpt");
    set("OPENAI_CHATGPT_ACCESS_TOKEN", "access-token");
    set("OPENAI_CHATGPT_EXPIRES_AT", FAR_FUTURE);

    expect(getInitialStep(null, "openai-chatgpt")).toBe("oauth-login");
    expect(needsCredentialSetup(null)).toBe(true);
  });

  test("skips oauth-login when a valid token is stored", () => {
    set("OPENWIKI_PROVIDER", "openai-chatgpt");
    storeChatGptTokens();

    // No model configured yet, so setup continues at the model step.
    expect(getInitialStep(null, "openai-chatgpt")).toBe("model");
    expect(getNextStepAfterProvider("openai-chatgpt", null)).toBe("model");
  });

  test("routes code onboarding to repo confirmation once credentials are set", () => {
    configureValidChatGptSession();

    expect(getInitialStep(null, "openai-chatgpt")).toBe("code-repo-confirm");
    expect(getNextStepAfterProvider("openai-chatgpt", null)).toBe(
      "code-repo-confirm",
    );
  });

  test("incomplete code onboarding skips the schedule step", () => {
    configureValidChatGptSession();

    expect(
      getInitialStep(
        null,
        "openai-chatgpt",
        CODE_ONBOARDING_WITHOUT_SCHEDULE,
        "code",
      ),
    ).toBe("code-repo-confirm");
    expect(
      getNextStepAfterProvider(
        "openai-chatgpt",
        null,
        CODE_ONBOARDING_WITHOUT_SCHEDULE,
        "code",
      ),
    ).toBe("code-repo-confirm");
  });
});

describe("code repo root detection", () => {
  test("finds the nearest .git parent", async () => {
    const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const nested = path.join(repo, "packages", "docs");

    try {
      await mkdir(path.join(repo, ".git"));
      await mkdir(nested, { recursive: true });

      expect(findNearestGitRepoRoot(nested)).toBe(repo);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });
});

describe("api-key providers keep the pasted-key step", () => {
  test("routes to api-key when the key is missing", () => {
    set("OPENWIKI_PROVIDER", "openai");

    expect(getInitialStep(null, "openai")).toBe("api-key");
    expect(getNextStepAfterProvider("openai", null)).toBe("api-key");
  });
});

describe("forceModel re-asks the model after a provider change", () => {
  test("goes to model even when a model id is already stored", () => {
    // Credential present so the credential step is skipped; model id stored.
    set("OPENWIKI_PROVIDER", "openai-chatgpt");
    storeChatGptTokens();
    set("OPENWIKI_MODEL_ID", "gpt-5.4-mini");
    set("LANGSMITH_API_KEY", "");

    // Without force, a stored model is kept (no model step).
    expect(
      getNextStepAfterProvider("openai-chatgpt", null, COMPLETE_ONBOARDING),
    ).toBeNull();
    // With force (provider was just changed), the model step is shown again.
    expect(
      getNextStepAfterProvider("openai-chatgpt", null, undefined, "code", true),
    ).toBe("model");
  });

  test("a per-run model override still suppresses the model step", () => {
    set("OPENWIKI_PROVIDER", "openai-chatgpt");
    storeChatGptTokens();
    set("LANGSMITH_API_KEY", "");

    expect(
      getNextStepAfterProvider(
        "openai-chatgpt",
        "gpt-5.5",
        COMPLETE_ONBOARDING,
        "code",
        true,
      ),
    ).toBeNull();
  });
});
