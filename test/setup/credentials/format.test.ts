import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

// Partial mock: only spawn is stubbed for openLoginUrl; execFile and the rest
// stay real so transitive importers (e.g. windows-acl) still resolve them.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import {
  getProviderApiKeyEnvKey,
  getProviderSecretKeyEnvKey,
  AWS_ACCESS_KEY_ID_ENV_KEY,
  AWS_BEARER_TOKEN_BEDROCK_ENV_KEY,
  AWS_SECRET_ACCESS_KEY_ENV_KEY,
  AWS_SESSION_TOKEN_ENV_KEY,
} from "../../../src/config/constants.ts";
import {
  copyToClipboard,
  formatSecretInputDisplay,
  formatTerminalHyperlink,
  getAwsCredentialRepairMessage,
  getCredentialSetupDetail,
  getOAuthAuthorizationStatusText,
  getSingleLineInputDisplayValue,
  mask,
  openLoginUrl,
} from "../../../src/setup/credentials/format.ts";

const MANAGED_KEYS = [
  "OPENAI_CHATGPT_ACCESS_TOKEN",
  "OPENAI_CHATGPT_REFRESH_TOKEN",
  "OPENAI_CHATGPT_ACCOUNT_ID",
  "OPENAI_CHATGPT_EXPIRES_AT",
  "OPENAI_CHATGPT_EMAIL",
  "OPENAI_CHATGPT_PLAN",
  getProviderApiKeyEnvKey("openai"),
  getProviderApiKeyEnvKey("bedrock"),
  getProviderSecretKeyEnvKey("bedrock"),
  AWS_ACCESS_KEY_ID_ENV_KEY,
  AWS_SECRET_ACCESS_KEY_ENV_KEY,
  AWS_SESSION_TOKEN_ENV_KEY,
  AWS_BEARER_TOKEN_BEDROCK_ENV_KEY,
].filter((key): key is string => key !== undefined);

let snapshot: Record<string, string | undefined>;

function set(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
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
  vi.restoreAllMocks();
});

describe("mask", () => {
  test("returns empty for empty input and one asterisk per character otherwise", () => {
    expect(mask("")).toBe("");
    expect(mask("abc")).toBe("***");
  });
});

describe("formatSecretInputDisplay", () => {
  test("renders one bullet per entered character, nothing when empty", () => {
    expect(formatSecretInputDisplay("")).toBe("");
    expect(formatSecretInputDisplay("ab")).toBe("••");
  });
});

describe("formatTerminalHyperlink", () => {
  test("wraps the label in an OSC 8 hyperlink pointing at the url", () => {
    const link = formatTerminalHyperlink("https://example.com", "click");

    expect(link).toBe("]8;;https://example.comclick]8;;");
  });
});

describe("getSingleLineInputDisplayValue", () => {
  test("returns empty when there is no room to render", () => {
    expect(getSingleLineInputDisplayValue("hello", 0)).toBe("");
  });

  test("returns the value unchanged when it fits", () => {
    expect(getSingleLineInputDisplayValue("hello", 10)).toBe("hello");
  });

  test("keeps only the tail when the budget is too small for an ellipsis", () => {
    expect(getSingleLineInputDisplayValue("hello", 3)).toBe("llo");
  });

  test("ellipsizes from the left when the value overflows a larger budget", () => {
    expect(getSingleLineInputDisplayValue("abcdefgh", 5)).toBe("...gh");
  });
});

describe("getOAuthAuthorizationStatusText", () => {
  test("reports the clipboard fallback once the url is copied", () => {
    expect(
      getOAuthAuthorizationStatusText({
        authProvider: "notion",
        copiedToClipboard: true,
      }),
    ).toContain("copied to clipboard");
  });

  test("names the provider-specific auth command when not copied", () => {
    expect(
      getOAuthAuthorizationStatusText({
        authProvider: "notion",
        copiedToClipboard: false,
      }),
    ).toContain("openwiki auth notion");
  });

  test("falls back to a generic auth command without a provider", () => {
    expect(
      getOAuthAuthorizationStatusText({ copiedToClipboard: false }),
    ).toContain("openwiki auth <provider>");
  });
});

describe("getAwsCredentialRepairMessage", () => {
  test("returns null for a non-aws provider", () => {
    expect(getAwsCredentialRepairMessage("openai")).toBeNull();
  });

  test("returns null when the bedrock credential set is not partially configured", () => {
    expect(getAwsCredentialRepairMessage("bedrock")).toBeNull();
  });

  test("explains which half of a partial legacy pair is missing", () => {
    const accessKey = getProviderApiKeyEnvKey("bedrock");
    const secretKey = getProviderSecretKeyEnvKey("bedrock");
    if (!accessKey || !secretKey) {
      throw new Error("bedrock must define a legacy key pair");
    }

    set(accessKey, "AKIAEXAMPLE");
    const message = getAwsCredentialRepairMessage("bedrock");

    expect(message).toContain(secretKey);
    expect(message).toContain("missing or blank");
  });

  test("names the standard AWS key pair when the legacy pair is empty but the standard pair is partial", () => {
    set(AWS_ACCESS_KEY_ID_ENV_KEY, "AKIASTANDARD");
    const message = getAwsCredentialRepairMessage("bedrock");

    expect(message).toContain(AWS_SECRET_ACCESS_KEY_ENV_KEY);
    expect(message).toContain(
      `${AWS_ACCESS_KEY_ID_ENV_KEY} and ${AWS_SECRET_ACCESS_KEY_ENV_KEY}`,
    );
    expect(message).toContain("missing or blank");
  });
});

describe("getCredentialSetupDetail", () => {
  test("tells an api-key provider to save its key when none is present", () => {
    const apiKey = getProviderApiKeyEnvKey("openai");
    if (!apiKey) throw new Error("openai must define an api key env var");

    const detail = getCredentialSetupDetail("openai");
    expect(detail).toContain("save");
    expect(detail).toContain(apiKey);
  });

  test("reports an api-key provider satisfied once the key is in the environment", () => {
    const apiKey = getProviderApiKeyEnvKey("openai");
    if (!apiKey) throw new Error("openai must define an api key env var");

    set(apiKey, "sk-test");
    expect(getCredentialSetupDetail("openai")).toBe(
      "available from environment",
    );
  });

  test("prompts an oauth provider to sign in when no token is stored", () => {
    expect(getCredentialSetupDetail("openai-chatgpt")).toBe(
      "sign in with your ChatGPT account",
    );
  });

  test("describes the aws-sdk credential chain for bedrock", () => {
    expect(getCredentialSetupDetail("bedrock")).toBe(
      "AWS SDK default credential chain",
    );
  });

  test("labels an oauth provider with the account decoded from passed-in tokens", () => {
    const tokens = {
      access: "access-token",
      refresh: "refresh-token",
      expiresAtMs: 0,
      accountId: "acct-123",
      email: "user@example.com",
      planType: "plus",
    };

    expect(getCredentialSetupDetail("openai-chatgpt", tokens)).toBe(
      "signed in as user@example.com (Plus)",
    );
  });

  test("falls back to a generic signed-in label when the account cannot be formatted", () => {
    const tokens = {
      access: "access-token",
      refresh: "refresh-token",
      expiresAtMs: 0,
      accountId: "acct-123",
      email: null,
      planType: null,
    };

    expect(getCredentialSetupDetail("openai-chatgpt", tokens)).toBe(
      "signed in with ChatGPT",
    );
  });

  test("reports the bedrock bearer token as taking precedence when set", () => {
    set(AWS_BEARER_TOKEN_BEDROCK_ENV_KEY, "bearer-token");

    expect(getCredentialSetupDetail("bedrock")).toBe(
      "Bedrock bearer token (takes precedence)",
    );
  });

  test("flags a partial legacy bedrock key pair", () => {
    const accessKey = getProviderApiKeyEnvKey("bedrock");
    if (!accessKey) throw new Error("bedrock must define a legacy api key");

    set(accessKey, "AKIAEXAMPLE");

    expect(getCredentialSetupDetail("bedrock")).toBe(
      "incomplete legacy Bedrock keys; set both or clear both",
    );
  });

  test("flags a partial standard AWS key pair when the legacy pair is empty", () => {
    set(AWS_ACCESS_KEY_ID_ENV_KEY, "AKIASTANDARD");

    expect(getCredentialSetupDetail("bedrock")).toBe(
      "incomplete standard AWS credentials; set the full set or unset it",
    );
  });

  test("reports a complete legacy bedrock pair as taking precedence", () => {
    const accessKey = getProviderApiKeyEnvKey("bedrock");
    const secretKey = getProviderSecretKeyEnvKey("bedrock");
    if (!accessKey || !secretKey) {
      throw new Error("bedrock must define a legacy key pair");
    }

    set(accessKey, "AKIAEXAMPLE");
    set(secretKey, "secret-example");

    expect(getCredentialSetupDetail("bedrock")).toBe(
      "legacy Bedrock keys (take precedence)",
    );
  });

  test("notes that an orphan AWS session token is ignored by the credential chain", () => {
    set(AWS_SESSION_TOKEN_ENV_KEY, "session-token");

    expect(getCredentialSetupDetail("bedrock")).toBe(
      "AWS SDK default credential chain (orphan AWS_SESSION_TOKEN ignored)",
    );
  });
});

describe("copyToClipboard", () => {
  test("emits the OSC 52 sequence carrying the base64-encoded text", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write);

    copyToClipboard("hello");

    const encoded = Buffer.from("hello", "utf8").toString("base64");
    expect(writes).toEqual([`]52;c;${encoded}`]);
  });
});

describe("openLoginUrl", () => {
  test("spawns a detached opener carrying the url and never throws on error", () => {
    const child = {
      on: vi.fn(),
      unref: vi.fn(),
    };
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);

    openLoginUrl("https://login.example/authorize");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The url appears in the argument vector on every platform (bare on
    // darwin/linux, quoted inside the cmd args on win32).
    expect(JSON.stringify(spawnMock.mock.calls[0])).toContain(
      "https://login.example/authorize",
    );
    // An error on the child must be swallowed (the url is also rendered).
    const errorHandler = child.on.mock.calls.find(
      (call) => call[0] === "error",
    )?.[1] as (() => void) | undefined;
    expect(() => errorHandler?.()).not.toThrow();
    expect(child.unref).toHaveBeenCalledTimes(1);
  });
});
