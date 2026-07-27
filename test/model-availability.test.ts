import { describe, expect, test } from "vitest";
import { getSelectedModelAvailability } from "../src/model-availability.ts";

const OPENAI_CHECK = {
  apiKey: "test-api-key",
  modelId: "gpt-test-model",
  provider: "openai" as const,
};

const NVIDIA_NIM_CHECK = {
  apiKey: "test-api-key",
  baseUrl: "https://nim.example/v1",
  baseUrlIsCustom: true,
  modelId: "nvidia/nemotron-test",
  provider: "nvidia" as const,
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

  test("accepts a model loaded by a custom NVIDIA NIM endpoint", async () => {
    const result = await getSelectedModelAvailability(
      NVIDIA_NIM_CHECK,
      (input, init) => {
        expect(input).toBe("https://nim.example/v1/models");
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer test-api-key",
        );
        return Promise.resolve(
          Response.json({ data: [{ id: "nvidia/nemotron-test" }] }),
        );
      },
    );

    expect(result).toEqual({ status: "available" });
  });

  test("rejects a model absent from a custom NVIDIA NIM endpoint", async () => {
    const result = await getSelectedModelAvailability(NVIDIA_NIM_CHECK, () =>
      Promise.resolve(Response.json({ data: [{ id: "another-model" }] })),
    );

    expect(result).toMatchObject({ status: "unavailable" });
  });

  test("does not block custom NVIDIA NIM when no API key is available", async () => {
    const result = await getSelectedModelAvailability(
      { ...NVIDIA_NIM_CHECK, apiKey: undefined },
      () => Promise.reject(new Error("fetch must not be called")),
    );

    expect(result).toMatchObject({ status: "unknown" });
  });

  test("does not block custom NVIDIA NIM when lookup fails", async () => {
    const result = await getSelectedModelAvailability(NVIDIA_NIM_CHECK, () =>
      Promise.reject(new Error("offline")),
    );

    expect(result).toMatchObject({ status: "unknown" });
  });

  test("does not assume the NVIDIA hosted endpoint exposes entitlement data", async () => {
    const result = await getSelectedModelAvailability(
      {
        ...NVIDIA_NIM_CHECK,
        baseUrl: "https://integrate.api.nvidia.com/v1",
        baseUrlIsCustom: false,
      },
      () => Promise.reject(new Error("fetch must not be called")),
    );

    expect(result).toMatchObject({ status: "unknown" });
  });
});
