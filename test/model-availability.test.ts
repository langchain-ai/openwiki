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

  test("does not block when a custom NVIDIA NIM endpoint hides its catalogue", async () => {
    const result = await getSelectedModelAvailability(NVIDIA_NIM_CHECK, () =>
      Promise.resolve(Response.json({ object: "list", data: [] })),
    );

    expect(result).toMatchObject({ status: "unknown" });
  });

  test("keeps the API root path when the base URL carries a query string", async () => {
    const result = await getSelectedModelAvailability(
      { ...NVIDIA_NIM_CHECK, baseUrl: "https://nim.example/v1?api-version=1" },
      (input) => {
        expect(input).toBe("https://nim.example/v1/models?api-version=1");
        return Promise.resolve(
          Response.json({ data: [{ id: "nvidia/nemotron-test" }] }),
        );
      },
    );

    expect(result).toEqual({ status: "available" });
  });

  test("bounds a custom NVIDIA NIM lookup with an abort signal", async () => {
    let signal: AbortSignal | undefined;

    const result = await getSelectedModelAvailability(
      NVIDIA_NIM_CHECK,
      (_input, init) => {
        signal = init?.signal ?? undefined;

        return Promise.resolve(
          Response.json({ data: [{ id: "nvidia/nemotron-test" }] }),
        );
      },
    );

    expect(result).toEqual({ status: "available" });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  test("treats an aborted lookup as non-blocking", async () => {
    const result = await getSelectedModelAvailability(NVIDIA_NIM_CHECK, () =>
      Promise.reject(
        new DOMException("The operation was aborted.", "TimeoutError"),
      ),
    );

    expect(result).toMatchObject({ status: "unknown" });
  });
});
