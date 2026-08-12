import { describe, expect, test } from "vitest";
import { getSelectedModelAvailability } from "../src/model-availability.ts";

const OPENAI_CHECK = {
  apiKey: "test-api-key",
  modelId: "gpt-test-model",
  provider: "openai" as const,
};

describe("getSelectedModelAvailability", () => {
  test("accepts a selected model returned by the OpenAI Models API", async () => {
    const result = await getSelectedModelAvailability(OPENAI_CHECK, () =>
      Promise.resolve(Response.json({ data: [{ id: "gpt-test-model" }] })),
    );

    expect(result).toEqual({ status: "available" });
  });

  test("rejects a selected model missing from the OpenAI Models API", async () => {
    const result = await getSelectedModelAvailability(OPENAI_CHECK, () =>
      Promise.resolve(Response.json({ data: [{ id: "another-model" }] })),
    );

    expect(result).toMatchObject({ status: "unavailable" });
  });

  test("does not block inference when the availability request fails", async () => {
    const result = await getSelectedModelAvailability(OPENAI_CHECK, () =>
      Promise.reject(new Error("offline")),
    );

    expect(result).toMatchObject({ status: "unknown" });
  });

  test("does not assume a custom endpoint has OpenAI Models API semantics", async () => {
    const result = await getSelectedModelAvailability(
      { ...OPENAI_CHECK, baseUrl: "https://gateway.example/v1" },
      () => Promise.reject(new Error("fetch must not be called")),
    );

    expect(result).toMatchObject({ status: "unknown" });
  });

  test("does not validate providers without an availability adapter", async () => {
    const result = await getSelectedModelAvailability({
      ...OPENAI_CHECK,
      provider: "anthropic",
    });

    expect(result).toMatchObject({ status: "unknown" });
  });
});
