import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import {
  getProviderConfig,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "../src/config/constants.ts";

type ActionStep = {
  env?: Record<string, string>;
  id?: string;
  name: string;
  run?: string;
  uses?: string;
  with?: Record<string, boolean | number | string>;
};

type ActionMetadata = {
  inputs: Record<string, { default?: string; required?: boolean }>;
  outputs: Record<string, { value: string }>;
  runs: {
    steps: ActionStep[];
    using: string;
  };
};

const require = createRequire(import.meta.url);
const { createOpenWikiEnvironment } = require(
  path.join(process.cwd(), "scripts", "run-action.cjs"),
) as {
  createOpenWikiEnvironment: (
    source: Record<string, string>,
  ) => Record<string, string>;
};

async function readAction(): Promise<ActionMetadata> {
  return parse(
    await readFile(path.join(process.cwd(), "action.yml"), "utf8"),
  ) as ActionMetadata;
}

describe("OpenWiki action", () => {
  test("pins every external action and checks out full history", async () => {
    const action = await readAction();
    const externalSteps = action.runs.steps.filter(
      (step): step is ActionStep & { uses: string } => step.uses !== undefined,
    );

    expect(action.runs.using).toBe("composite");
    expect(externalSteps).toHaveLength(3);
    for (const step of externalSteps) {
      expect(step.uses).toMatch(/^[^@]+@[0-9a-f]{40}$/u);
      expect(step.env).toBeUndefined();
    }

    const checkout = externalSteps.find((step) =>
      step.uses.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  test("installs the action's matching package release and pinned validators", async () => {
    const action = await readAction();
    const install = action.runs.steps.find(
      (step) => step.name === "Install OpenWiki",
    );

    expect(install?.run).toContain("process.env.ACTION_PACKAGE_JSON");
    expect(install?.run).toContain('"openwiki@$version"');
    expect(install?.run).toContain("mermaid@11.16.0");
    expect(install?.run).toContain("jsdom@29.1.1");
    expect(install?.run).toContain("version is not valid semver");
  });

  test("runs code updates and scopes the default pull request", async () => {
    const action = await readAction();
    const run = action.runs.steps.find((step) => step.name === "Run OpenWiki");
    const pullRequest = action.runs.steps.find(
      (step) => step.id === "pull-request",
    );

    expect(run?.run).toContain("scripts/run-action.cjs");
    expect(run?.env?.INPUT_API_KEY).toBe("${{ inputs.api-key }}");
    expect(action.inputs.provider?.required).toBe(true);
    expect(pullRequest?.uses).toMatch(
      /^peter-evans\/create-pull-request@[0-9a-f]{40}$/u,
    );
    expect(pullRequest?.with?.token).toBe(
      "${{ inputs.token || github.token }}",
    );
    expect(action.inputs["add-paths"]?.default?.trim().split("\n")).toEqual([
      "openwiki",
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    expect(action.inputs["branch"]?.default).toBe("openwiki/update");
    expect(action.outputs["pull-request-url"]?.value).toBe(
      "${{ steps.pull-request.outputs.pull-request-url }}",
    );
  });

  test("maps every provider input without forwarding generic secrets", () => {
    for (const provider of SELECTABLE_OPENWIKI_PROVIDERS) {
      const config = getProviderConfig(provider);
      const environment = createOpenWikiEnvironment({
        INPUT_API_KEY: "provider-secret",
        INPUT_BASE_URL: "https://provider.example.com",
        INPUT_LOCATION: "global",
        INPUT_PROJECT: "docs-project",
        INPUT_PROVIDER: provider,
        INPUT_REGION: "us-east-1",
        INPUT_SECRET_KEY: "secondary-secret",
        PATH: "/usr/bin",
      });

      if (config.apiKeyEnvKey !== undefined) {
        expect(environment[config.apiKeyEnvKey]).toBe("provider-secret");
      }
      if (config.baseUrlEnvKey !== undefined) {
        expect(environment[config.baseUrlEnvKey]).toBe(
          "https://provider.example.com",
        );
      }
      if (config.locationEnvKey !== undefined) {
        expect(environment[config.locationEnvKey]).toBe("global");
      }
      if (config.projectEnvKey !== undefined) {
        expect(environment[config.projectEnvKey]).toBe("docs-project");
      }
      if (config.regionEnvKey !== undefined) {
        expect(environment[config.regionEnvKey]).toBe("us-east-1");
      }
      if (config.secretKeyEnvKey !== undefined) {
        expect(environment[config.secretKeyEnvKey]).toBe("secondary-secret");
      }
      expect(environment.INPUT_API_KEY).toBeUndefined();
      expect(environment.INPUT_PROVIDER).toBeUndefined();
      expect(environment.OPENWIKI_PROVIDER).toBe(provider);
      expect(environment.PATH).toBe("/usr/bin");
    }
  });

  test("maps cloud and tracing inputs only into the OpenWiki process", () => {
    const bedrock = createOpenWikiEnvironment({
      INPUT_API_KEY: "access",
      INPUT_LANGSMITH_API_KEY: "trace-secret",
      INPUT_MODEL_ID: "model",
      INPUT_PROVIDER: "bedrock",
      INPUT_REGION: "us-east-1",
      INPUT_SECRET_KEY: "secret",
      INPUT_SESSION_TOKEN: "session",
    });
    expect(bedrock).toMatchObject({
      BEDROCK_AWS_ACCESS_KEY_ID: "access",
      BEDROCK_AWS_REGION: "us-east-1",
      BEDROCK_AWS_SECRET_ACCESS_KEY: "secret",
      BEDROCK_AWS_SESSION_TOKEN: "session",
      LANGSMITH_API_KEY: "trace-secret",
      OPENWIKI_MODEL_ID: "model",
      OPENWIKI_PROVIDER: "bedrock",
    });
    expect(bedrock.INPUT_SECRET_KEY).toBeUndefined();
    expect(bedrock.INPUT_LANGSMITH_API_KEY).toBeUndefined();

    const vertex = createOpenWikiEnvironment({
      INPUT_LOCATION: "global",
      INPUT_PROJECT: "docs-project",
      INPUT_PROVIDER: "gemini-enterprise",
    });
    expect(vertex).toMatchObject({
      GOOGLE_CLOUD_LOCATION: "global",
      GOOGLE_CLOUD_PROJECT: "docs-project",
      OPENWIKI_PROVIDER: "gemini-enterprise",
    });
  });

  test("rejects unknown providers before starting OpenWiki", () => {
    for (const provider of ["unknown", "__proto__", ""]) {
      expect(() =>
        createOpenWikiEnvironment({ INPUT_PROVIDER: provider }),
      ).toThrow(/Unsupported OpenWiki provider/u);
    }
  });
});
