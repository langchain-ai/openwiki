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

  test("langsmith gets runtime-evidence synthesis guidance", () => {
    const guidance = createConnectorSynthesisGuidance(registry.langsmith);

    expect(guidance).toContain("openwiki_read_raw_item");
    expect(guidance).toContain("Never copy raw run inputs or outputs");
  });

  test("personal connectors do get synthesis guidance", () => {
    expect(
      createConnectorSynthesisGuidance(registry["git-repo"]).length,
    ).toBeGreaterThan(0);
  });

  test("no personal connector receives the langsmith guidance", () => {
    // The langsmith arm is keyed on connector.id, and langsmith is never a
    // personal source, so its runtime-evidence guidance cannot leak into a
    // personal run.
    for (const id of CONNECTOR_IDS) {
      if (id === "langsmith") {
        continue;
      }
      expect(createConnectorSynthesisGuidance(registry[id])).not.toContain(
        "openwiki_read_raw_item",
      );
    }
  });
});
