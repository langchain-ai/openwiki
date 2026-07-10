import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getErrorMessage,
  isOpenRouterServerError,
  sanitizeDiagnosticText,
} from "../src/diagnostics.ts";
import { sanitizeOpenRouterResponseBody } from "../src/agent/index.ts";

describe("sanitizeDiagnosticText", () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalOpenAiCompatibleKey = process.env.OPENAI_COMPATIBLE_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
  });

  afterEach(() => {
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
  });

  test("redacts the exact value of a secret set in the environment", () => {
    process.env.OPENAI_API_KEY = "super-secret-value-12345";

    const result = sanitizeDiagnosticText(
      "request failed with key super-secret-value-12345 attached",
    );

    expect(result).not.toContain("super-secret-value-12345");
    expect(result).toContain("[REDACTED:OPENAI_API_KEY]");
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
