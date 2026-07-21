import { describe, expect, test } from "vitest";
import {
  CONNECTOR_IDS,
  createConnectorRegistry,
} from "../src/connectors/registry.ts";
import { createConnectorSynthesisGuidance } from "../src/ingestion.ts";

const registry = createConnectorRegistry();

describe("connector modes", () => {
  test("langsmith is a code-mode connector with the API-key requiredEnv", () => {
    expect(registry.langsmith.mode).toBe("code");
    expect(registry.langsmith.requiredEnv).toContain(
      "OPENWIKI_LANGSMITH_API_KEY",
    );
  });

  test("every other connector is personal-mode", () => {
    for (const id of CONNECTOR_IDS) {
      if (id === "langsmith") {
        continue;
      }
      expect(registry[id].mode).toBe("personal");
    }
  });

  test("code-mode connectors get no personal synthesis guidance", () => {
    // Driven by mode: a code-mode connector returns an empty string rather than
    // routing to /themes.md etc.
    expect(createConnectorSynthesisGuidance(registry.langsmith)).toBe("");
  });

  test("personal connectors do get synthesis guidance", () => {
    expect(
      createConnectorSynthesisGuidance(registry["git-repo"]).length,
    ).toBeGreaterThan(0);
  });
});
