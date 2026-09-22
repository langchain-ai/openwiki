import { describe, expect, test } from "vitest";
import { ChatGoogle } from "@langchain/google/node";
import {
  LabeledVertexChatGoogle,
  parseVertexLabels,
} from "../../src/agent/vertex-labels.ts";

describe("parseVertexLabels", () => {
  test("treats an unset or empty option as disabled", () => {
    expect(parseVertexLabels(undefined)).toBeUndefined();
    expect(parseVertexLabels("")).toBeUndefined();
    expect(parseVertexLabels("{}")).toBeUndefined();
  });

  test("accepts valid labels without changing their values", () => {
    expect(
      parseVertexLabels('{"app":"openwiki","cost_center":"docs-1","note":""}'),
    ).toEqual({
      app: "openwiki",
      cost_center: "docs-1",
      note: "",
    });
  });

  test("accepts international lowercase letters", () => {
    expect(parseVertexLabels('{"équipe":"ricerca_1"}')).toEqual({
      équipe: "ricerca_1",
    });
  });

  test.each([
    "not json",
    "null",
    "[]",
    '"text"',
    '{"app":1}',
    '{"App":"openwiki"}',
    '{"1app":"openwiki"}',
    '{"app":"Has Spaces"}',
    JSON.stringify({ ["a".repeat(64)]: "x" }),
    JSON.stringify({ app: "x".repeat(64) }),
    JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [`key_${i}`, "x"]),
      ),
    ),
  ])("rejects invalid labels before making a request: %s", (raw) => {
    expect(() => parseVertexLabels(raw)).toThrow(/OPENWIKI_VERTEX_LABELS/u);
  });
});

const RESPONSE_BODY = JSON.stringify({
  candidates: [
    {
      content: { role: "model", parts: [{ text: "ok" }] },
      finishReason: "STOP",
    },
  ],
});

function createFakeClient(requests: Request[], streaming: boolean) {
  return {
    hasApiKey: () => false,
    getProjectId: () => Promise.resolve("test-project"),
    fetch: (request: Request) => {
      requests.push(request);
      return Promise.resolve(
        streaming
          ? new Response(`data: ${RESPONSE_BODY}\n\n`, {
              headers: { "content-type": "text/event-stream" },
            })
          : new Response(RESPONSE_BODY, {
              headers: { "content-type": "application/json" },
            }),
      );
    },
  };
}

describe("Vertex Gemini request labels", () => {
  test.each([false, true])(
    "sends labels on the wire (streaming: %s)",
    async (streaming) => {
      const requests: Request[] = [];
      const model = new LabeledVertexChatGoogle(
        {
          model: "gemini-3.1-pro",
          platformType: "gcp",
          location: "us-central1",
          apiKey: "",
          apiClient: createFakeClient(requests, streaming),
        },
        { app: "openwiki", team: "docs" },
      );

      if (streaming) {
        for await (const chunk of await model.stream("hello")) {
          expect(chunk).toBeDefined();
        }
      } else {
        await model.invoke("hello");
      }

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toContain(
        "/projects/test-project/locations/us-central1/",
      );
      expect(await requests[0]?.json()).toMatchObject({
        labels: { app: "openwiki", team: "docs" },
      });
    },
  );

  test("does not add labels to an unconfigured ChatGoogle request", async () => {
    const requests: Request[] = [];
    const model = new ChatGoogle({
      model: "gemini-3.1-pro",
      platformType: "gcp",
      location: "us-central1",
      apiKey: "",
      apiClient: createFakeClient(requests, false),
    });

    await model.invoke("hello");

    expect(requests).toHaveLength(1);
    expect(await requests[0]?.json()).not.toHaveProperty("labels");
  });
});
