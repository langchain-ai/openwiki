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
});

describe("createConnectorSynthesisGuidance", () => {
  test("langsmith gets the runtime-evidence guidance", () => {
    const guidance = createConnectorSynthesisGuidance(registry.langsmith);

    expect(guidance).toContain("openwiki_read_raw_item");
    expect(guidance).toContain("Never copy raw run inputs or outputs");
    // The north star: a runtime snapshot for working here, judged by whether it
    // changes how an agent approaches work in the codebase.
    expect(guidance).toContain("would it change how an agent approaches work");
  });

  test("langsmith guidance is sample-aware and names the runtime-behavior page", () => {
    const guidance = createConnectorSynthesisGuidance(registry.langsmith);

    // Anomaly-weighted sample: the agent must read buckets as composition and
    // use baseline medians, not treat counts as fleet rates.
    expect(guidance).toContain("anomaly-weighted");
    expect(guidance).toContain("bucket");
    expect(guidance).toContain("baseline");
    // The connector maintains one consolidated, named page.
    expect(guidance).toContain("runtime-behavior.md");
  });

  test("langsmith guidance is code-anchored and forbids restating architecture", () => {
    const guidance = createConnectorSynthesisGuidance(registry.langsmith);

    // Divergence-first: test code claims against production, don't just profile.
    expect(guidance).toContain("Start from the code");
    expect(guidance).toContain("installed-but-unused");
    // Kill the architecture-restatement filler.
    expect(guidance).toContain("Do NOT reproduce the middleware/tool assembly");
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
