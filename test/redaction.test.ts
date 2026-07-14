import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getErrorMessage,
  isOpenRouterServerError,
  isSecretLikeKey,
  sanitizeDiagnosticText,
} from "../src/diagnostics.ts";
import { sanitizeOpenRouterResponseBody } from "../src/agent/index.ts";

describe("isSecretLikeKey", () => {
  // The shared predicate must be the union of every term the three former
  // implementations (cli.tsx, agent/index.ts, mcp-runtime.ts) matched, so a key
  // redacted by one path is redacted by all of them.
  test.each([
    "apiKey",
    "api_key",
    "api-key",
    "authorization",
    "Bearer",
    "access_token",
    "refresh_token",
    "client_secret",
    "password",
    "user_id",
    "Cookie",
  ])("flags secret-bearing key %s (case-insensitive)", (key) => {
    expect(isSecretLikeKey(key)).toBe(true);
    expect(isSecretLikeKey(key.toUpperCase())).toBe(true);
  });

  test.each(["email", "plan", "model", "count", "name", "url"])(
    "does not flag benign key %s",
    (key) => {
      expect(isSecretLikeKey(key)).toBe(false);
    },
  );
});

describe("sanitizeOpenRouterResponseBody", () => {
  test("redacts values for the unified secret key set", () => {
    const body = JSON.stringify({
      access_token: "should-be-hidden",
      user_id: "u-123",
      cookie: "session=abc",
      model: "gpt-5.5",
    });
    const sanitized = sanitizeOpenRouterResponseBody(body);

    expect(sanitized).not.toContain("should-be-hidden");
    expect(sanitized).not.toContain("u-123");
    expect(sanitized).not.toContain("session=abc");
    expect(sanitized).toContain("[REDACTED]");
    // Non-secret fields are preserved.
    expect(sanitized).toContain("gpt-5.5");
  });
});

describe("sanitizeDiagnosticText", () => {
  const originalNebiusKey = process.env.NEBIUS_API_KEY;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalOpenAiCompatibleKey = process.env.OPENAI_COMPATIBLE_API_KEY;
  const originalNvidiaKey = process.env.NVIDIA_API_KEY;

  beforeEach(() => {
    delete process.env.NEBIUS_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
    delete process.env.NVIDIA_API_KEY;
  });

  afterEach(() => {
    if (originalNebiusKey === undefined) {
      delete process.env.NEBIUS_API_KEY;
    } else {
      process.env.NEBIUS_API_KEY = originalNebiusKey;
    }

    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
    if (originalOpenAiCompatibleKey === undefined) {
      delete process.env.OPENAI_COMPATIBLE_API_KEY;
    } else {
      process.env.OPENAI_COMPATIBLE_API_KEY = originalOpenAiCompatibleKey;
    }

    if (originalNvidiaKey === undefined) {
      delete process.env.NVIDIA_API_KEY;
    } else {
      process.env.NVIDIA_API_KEY = originalNvidiaKey;
    }
  });

  test("redacts the exact value of a secret set in the environment", () => {
    process.env.OPENAI_API_KEY = "super-secret-value-12345";

    const result = sanitizeDiagnosticText(
      "request failed with key super-secret-value-12345 attached",
    );

    expect(result).not.toContain("super-secret-value-12345");
    expect(result).toContain("[REDACTED:OPENAI_API_KEY]");
  });

  test("redacts the Nebius API key when set in the environment", () => {
    process.env.NEBIUS_API_KEY = "nebius-secret-value-12345";

    const result = sanitizeDiagnosticText(
      "request failed with key nebius-secret-value-12345 attached",
    );

    expect(result).not.toContain("nebius-secret-value-12345");
    expect(result).toContain("[REDACTED:NEBIUS_API_KEY]");
  });

  test("redacts the exact value of NVIDIA_API_KEY when set", () => {
    process.env.NVIDIA_API_KEY = "nvapi-secret-value-67890";

    const result = sanitizeDiagnosticText(
      "request failed with key nvapi-secret-value-67890 attached",
    );

    expect(result).not.toContain("nvapi-secret-value-67890");
    expect(result).toContain("[REDACTED:NVIDIA_API_KEY]");
  });

  test("redacts OpenAI-style sk- tokens", () => {
    const result = sanitizeDiagnosticText("token sk-abcDEF123_456 rejected");

    expect(result).not.toContain("sk-abcDEF123_456");
    expect(result).toContain("[REDACTED:API_KEY]");
  });

  test("redacts OpenRouter sk-or-v1- tokens with the OpenRouter label", () => {
    const result = sanitizeDiagnosticText("using sk-or-v1-deadbeef00 now");

    expect(result).not.toContain("sk-or-v1-deadbeef00");
    expect(result).toContain("[REDACTED:OPENROUTER_API_KEY]");
  });

  test("redacts Bearer tokens", () => {
    const result = sanitizeDiagnosticText(
      "Authorization: Bearer eyJhbGciOi.J9.abc-123",
    );

    expect(result).not.toContain("eyJhbGciOi.J9.abc-123");
    expect(result).toContain("Bearer [REDACTED]");
  });

  test("redacts LangSmith ls_/lsv_ keys", () => {
    const result = sanitizeDiagnosticText("langsmith lsv_1234abcd tracing");

    expect(result).not.toContain("lsv_1234abcd");
    expect(result).toContain("[REDACTED:LANGSMITH_API_KEY]");
  });

  test('redacts "Incorrect API key provided: …" phrasing', () => {
    const result = sanitizeDiagnosticText(
      "Incorrect API key provided: myLeakedKey. Check your account.",
    );

    expect(result).not.toContain("myLeakedKey");
    expect(result).toContain("[REDACTED:API_KEY]");
  });

  test("leaves non-secret text untouched", () => {
    const message = "Repository has 12 files and the wiki is already current.";

    expect(sanitizeDiagnosticText(message)).toBe(message);
  });

  test("redacts the exact value of OPENAI_COMPATIBLE_API_KEY set in the environment", () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = "compatible-secret-key-99999";

    const result = sanitizeDiagnosticText(
      "request failed with key compatible-secret-key-99999 attached",
    );

    expect(result).not.toContain("compatible-secret-key-99999");
    expect(result).toContain("[REDACTED:OPENAI_COMPATIBLE_API_KEY]");
  });
});

describe("isOpenRouterServerError", () => {
  test("detects a 500 OpenRouterError object", () => {
    const error = Object.assign(new Error("boom"), {
      name: "OpenRouterError",
      status: 500,
    });

    expect(isOpenRouterServerError(error, "boom")).toBe(true);
  });

  test("detects a provider 500 from the message text", () => {
    expect(
      isOpenRouterServerError(
        new Error("OpenRouterError: 500 Internal Server Error"),
        "OpenRouterError: 500 Internal Server Error",
      ),
    ).toBe(true);
  });

  test("is false for a normal error", () => {
    expect(
      isOpenRouterServerError(new Error("bad request"), "bad request"),
    ).toBe(false);
  });
});

describe("getErrorMessage", () => {
  test("returns a friendly, actionable message for provider 500s", () => {
    const error = Object.assign(new Error("500"), {
      name: "OpenRouterError",
      status: 500,
    });

    expect(getErrorMessage(error)).toMatch(/500 Internal Server Error/u);
    expect(getErrorMessage(error)).toMatch(/\/model/u);
  });

  test("falls back to a generic message for non-Error values", () => {
    expect(getErrorMessage("just a string")).toBe("OpenWiki agent run failed.");
  });

  test("redacts secrets in the underlying error message", () => {
    expect(getErrorMessage(new Error("bad token sk-abcDEF123"))).toContain(
      "[REDACTED:API_KEY]",
    );
  });
});

describe("sanitizeOpenRouterResponseBody", () => {
  test("redacts secret-bearing JSON values while keeping the key name", () => {
    const body = JSON.stringify({ api_key: "secret123", model: "glm-5.2" });
    const result = sanitizeOpenRouterResponseBody(body);

    expect(result).not.toContain("secret123");
    expect(result).toContain('"api_key":"[REDACTED]"');
    expect(result).toContain("glm-5.2");
  });

  test("redacts authorization and token fields", () => {
    const body = JSON.stringify({
      authorization: "Bearer abc",
      token: "tok_123",
    });
    const result = sanitizeOpenRouterResponseBody(body);

    expect(result).not.toContain("Bearer abc");
    expect(result).not.toContain("tok_123");
  });

  test("leaves a body with no secret-shaped keys untouched", () => {
    const body = JSON.stringify({ error: "rate limited", status: 429 });

    expect(sanitizeOpenRouterResponseBody(body)).toBe(body);
  });
});
