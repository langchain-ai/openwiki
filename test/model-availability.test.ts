import { describe, expect, test } from "vitest";
import { getSelectedModelAvailability } from "../src/model-availability.ts";

const OPENAI_CHECK = {
  apiKey: "test-api-key",
  modelId: "gpt-test-model",
  provider: "openai" as const,
};

const COPILOT_CHECK = {
  apiKey: "test-copilot-token",
  modelId: "claude-fable-5",
  provider: "copilot" as const,
};

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

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

  test("accepts a selected chat model enabled by Copilot account policy", async () => {
    const requests: string[] = [];
    const result = await getSelectedModelAvailability(
      COPILOT_CHECK,
      (input, init) => {
        requests.push(fetchInputUrl(input));
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer test-copilot-token",
        );
        return Promise.resolve(
          Response.json({
            data: [
              {
                id: "claude-fable-5",
                capabilities: { type: "chat" },
                model_picker_enabled: false,
                policy: { state: "enabled" },
              },
            ],
          }),
        );
      },
    );

    expect(result).toEqual({ status: "available" });
    expect(requests).toEqual(["https://api.githubcopilot.com/models"]);
  });

  test("rejects a selected Copilot model missing from the account model list", async () => {
    const result = await getSelectedModelAvailability(COPILOT_CHECK, () =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: "gpt-5.6-terra",
              capabilities: { type: "chat" },
              model_picker_enabled: true,
            },
          ],
        }),
      ),
    );

    expect(result).toMatchObject({ status: "unavailable" });
  });

  test("rejects a selected Copilot model disabled by account policy", async () => {
    const result = await getSelectedModelAvailability(COPILOT_CHECK, () =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: "claude-fable-5",
              capabilities: { type: "chat" },
              model_picker_enabled: false,
              policy: { state: "disabled" },
            },
          ],
        }),
      ),
    );

    expect(result).toMatchObject({ status: "unavailable" });
  });

  test("rejects a selected Copilot model that is not a chat model", async () => {
    const result = await getSelectedModelAvailability(COPILOT_CHECK, () =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: "claude-fable-5",
              capabilities: { type: "embeddings" },
              model_picker_enabled: true,
            },
          ],
        }),
      ),
    );

    expect(result).toMatchObject({ status: "unavailable" });
  });

  test("accepts a picker-enabled chat model when policy state is absent", async () => {
    const result = await getSelectedModelAvailability(COPILOT_CHECK, () =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: "claude-fable-5",
              capabilities: { type: "chat" },
              model_picker_enabled: true,
            },
          ],
        }),
      ),
    );

    expect(result).toEqual({ status: "available" });
  });

  test("does not block inference when Copilot eligibility is ambiguous", async () => {
    const result = await getSelectedModelAvailability(COPILOT_CHECK, () =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: "claude-fable-5",
              capabilities: { type: "chat" },
              model_picker_enabled: false,
            },
          ],
        }),
      ),
    );

    expect(result).toMatchObject({ status: "unknown" });
  });

  test("does not block inference when no Copilot token is available", async () => {
    const result = await getSelectedModelAvailability(
      { ...COPILOT_CHECK, apiKey: undefined },
      () => Promise.reject(new Error("fetch must not be called")),
    );

    expect(result).toMatchObject({ status: "unknown" });
  });

  test("does not block inference when the Copilot Models API fails", async () => {
    const result = await getSelectedModelAvailability(COPILOT_CHECK, () =>
      Promise.resolve(new Response("forbidden", { status: 403 })),
    );

    expect(result).toMatchObject({ status: "unknown" });
  });

  test("does not block inference when the Copilot Models API shape is unexpected", async () => {
    const result = await getSelectedModelAvailability(COPILOT_CHECK, () =>
      Promise.resolve(Response.json({ models: [] })),
    );

    expect(result).toMatchObject({ status: "unknown" });
  });

  test("uses the configured Copilot base URL without duplicating slashes", async () => {
    const requests: string[] = [];
    const result = await getSelectedModelAvailability(
      { ...COPILOT_CHECK, baseUrl: "https://tenant.ghe.com/api/copilot/" },
      (input) => {
        requests.push(fetchInputUrl(input));
        return Promise.resolve(
          Response.json({
            data: [
              {
                id: "claude-fable-5",
                capabilities: { type: "chat" },
                model_picker_enabled: false,
                policy: { state: "enabled" },
              },
            ],
          }),
        );
      },
    );

    expect(result).toEqual({ status: "available" });
    expect(requests).toEqual(["https://tenant.ghe.com/api/copilot/models"]);
  });

  test("does not validate providers without an availability adapter", async () => {
    const result = await getSelectedModelAvailability({
      ...OPENAI_CHECK,
      provider: "anthropic",
    });

    expect(result).toMatchObject({ status: "unknown" });
  });
});
