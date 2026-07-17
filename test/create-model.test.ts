import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatBedrockConverse } from "@langchain/aws";
import { ChatGoogle } from "@langchain/google/node";
import { ChatOpenAI } from "@langchain/openai";
import { createModel } from "../src/agent/index.ts";

// Constructing a LangChain chat model makes no network calls (auth/clients
// resolve lazily on first request), so these assert the gemini-enterprise
// surface dispatch and the project-id guard without needing GCP credentials.

const PROJECT_KEY = "GOOGLE_CLOUD_PROJECT";
const LOCATION_KEY = "GOOGLE_CLOUD_LOCATION";
const GEMINI_KEY = "GEMINI_API_KEY";

function modelName(model: unknown): string | undefined {
  return (model as { model?: string }).model;
}

describe("createModel gemini-enterprise surface dispatch", () => {
  let savedProject: string | undefined;
  let savedLocation: string | undefined;

  beforeEach(() => {
    savedProject = process.env[PROJECT_KEY];
    savedLocation = process.env[LOCATION_KEY];
    process.env[PROJECT_KEY] = "test-project";
    process.env[LOCATION_KEY] = "us-central1";
  });

  afterEach(() => {
    restoreEnv(PROJECT_KEY, savedProject);
    restoreEnv(LOCATION_KEY, savedLocation);
  });

  test("routes Claude IDs to ChatAnthropic and strips the publisher path", () => {
    const model = createModel(
      "gemini-enterprise",
      "publishers/anthropic/models/claude-sonnet-4-5@20250929",
      0,
    );

    expect(model).toBeInstanceOf(ChatAnthropic);
    expect(modelName(model)).toBe("claude-sonnet-4-5@20250929");
  });

  test("routes MaaS IDs to ChatOpenAI and normalizes to publisher/model", () => {
    const model = createModel(
      "gemini-enterprise",
      "publishers/meta/models/llama-3.3-70b-instruct-maas",
      0,
    );

    expect(model).toBeInstanceOf(ChatOpenAI);
    expect(model).not.toBeInstanceOf(ChatGoogle);
    expect(modelName(model)).toBe("meta/llama-3.3-70b-instruct-maas");
  });

  test("routes Gemini IDs to ChatGoogle", () => {
    const model = createModel("gemini-enterprise", "gemini-3.1-pro", 0);

    expect(model).toBeInstanceOf(ChatGoogle);
    expect(modelName(model)).toBe("gemini-3.1-pro");
  });

  test("routes Gemma IDs to ChatGoogle (default surface)", () => {
    const model = createModel("gemini-enterprise", "gemma-3-27b-it", 0);

    expect(model).toBeInstanceOf(ChatGoogle);
    expect(modelName(model)).toBe("gemma-3-27b-it");
  });

  test("strips the publisher path on the Gemini surface", () => {
    const model = createModel(
      "gemini-enterprise",
      "publishers/google/models/gemini-3-pro",
      0,
    );

    expect(model).toBeInstanceOf(ChatGoogle);
    expect(modelName(model)).toBe("gemini-3-pro");
  });

  test("resolves the global endpoint for the MaaS surface when location is unset", () => {
    delete process.env[LOCATION_KEY];

    const model = createModel(
      "gemini-enterprise",
      "publishers/meta/models/llama-3.3-70b-instruct-maas",
      0,
    );

    // The global endpoint uses the unprefixed host (not global-aiplatform…).
    const baseURL = (model as { clientConfig?: { baseURL?: string } })
      .clientConfig?.baseURL;
    expect(baseURL).toBe(
      "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/endpoints/openapi",
    );
  });

  test("throws a clear error when the project ID is missing", () => {
    delete process.env[PROJECT_KEY];

    expect(() => createModel("gemini-enterprise", "gemini-3.1-pro", 0)).toThrow(
      /GOOGLE_CLOUD_PROJECT is required/u,
    );
  });
});

describe("createModel gemini (AI Studio)", () => {
  let savedGeminiKey: string | undefined;

  beforeEach(() => {
    savedGeminiKey = process.env[GEMINI_KEY];
    process.env[GEMINI_KEY] = "test-gemini-key";
  });

  afterEach(() => {
    restoreEnv(GEMINI_KEY, savedGeminiKey);
  });

  test("builds a ChatGoogle AI Studio client with v0 output pinned", () => {
    const model = createModel("gemini", "gemini-3.1-pro", 0);

    expect(model).toBeInstanceOf(ChatGoogle);
    expect(modelName(model)).toBe("gemini-3.1-pro");

    // Thought-signature workaround: streaming disabled + v0 output, on the AI
    // Studio ("gai") platform. (The API key is stored privately by ChatGoogle
    // and is asserted via the constructor mock in gemini-retry.test.ts.)
    const config = model as {
      _platform?: string;
      disableStreaming?: boolean;
      outputVersion?: string;
    };
    expect(config.disableStreaming).toBe(true);
    expect(config.outputVersion).toBe("v0");
    expect(config._platform).toBe("gai");
  });
});

const BEDROCK_ACCESS_KEY = "BEDROCK_AWS_ACCESS_KEY_ID";
const BEDROCK_SECRET_KEY = "BEDROCK_AWS_SECRET_ACCESS_KEY";
const BEDROCK_REGION = "BEDROCK_AWS_REGION";
const AWS_REGION_KEY = "AWS_REGION";
const AWS_DEFAULT_REGION_KEY = "AWS_DEFAULT_REGION";

describe("createModel bedrock (default AWS credential chain vs static keys)", () => {
  let savedAccessKey: string | undefined;
  let savedSecretKey: string | undefined;
  let savedRegion: string | undefined;
  let savedAwsRegion: string | undefined;
  let savedAwsDefaultRegion: string | undefined;

  beforeEach(() => {
    savedAccessKey = process.env[BEDROCK_ACCESS_KEY];
    savedSecretKey = process.env[BEDROCK_SECRET_KEY];
    savedRegion = process.env[BEDROCK_REGION];
    savedAwsRegion = process.env[AWS_REGION_KEY];
    savedAwsDefaultRegion = process.env[AWS_DEFAULT_REGION_KEY];
    delete process.env[BEDROCK_ACCESS_KEY];
    delete process.env[BEDROCK_SECRET_KEY];
    delete process.env[BEDROCK_REGION];
    delete process.env[AWS_REGION_KEY];
    delete process.env[AWS_DEFAULT_REGION_KEY];
  });

  afterEach(() => {
    restoreEnv(BEDROCK_ACCESS_KEY, savedAccessKey);
    restoreEnv(BEDROCK_SECRET_KEY, savedSecretKey);
    restoreEnv(BEDROCK_REGION, savedRegion);
    restoreEnv(AWS_REGION_KEY, savedAwsRegion);
    restoreEnv(AWS_DEFAULT_REGION_KEY, savedAwsDefaultRegion);
  });

  test("omits credentials when none are configured, relying on the AWS default chain", () => {
    // A region still has to come from somewhere (ChatBedrockConverse cannot
    // resolve one from a bare credential provider chain the way it resolves
    // credentials), so this sets AWS_REGION — the variable IRSA/ECS/Lambda
    // commonly inject — and leaves every BEDROCK_AWS_* var unset.
    process.env[AWS_REGION_KEY] = "us-west-2";

    const model = createModel(
      "bedrock",
      "anthropic.claude-sonnet-5-20260101-v1:0",
      0,
    ) as { region?: string };

    expect(model).toBeInstanceOf(ChatBedrockConverse);
    // ChatBedrockConverse resolves its own default-chain credentials
    // internally when none are passed in, rather than exposing them as a
    // field — so the observable contract here is that construction succeeds
    // without BEDROCK_AWS_ACCESS_KEY_ID/BEDROCK_AWS_SECRET_ACCESS_KEY set,
    // and that the AWS_REGION fallback reached the client.
    expect(modelName(model)).toBe("anthropic.claude-sonnet-5-20260101-v1:0");
    expect(model.region).toBe("us-west-2");
  });

  test("passes static credentials and region through when both are configured", () => {
    process.env[BEDROCK_ACCESS_KEY] = "AKIAEXAMPLE";
    process.env[BEDROCK_SECRET_KEY] = "secret-example";
    process.env[BEDROCK_REGION] = "us-east-1";

    const model = createModel(
      "bedrock",
      "anthropic.claude-sonnet-5-20260101-v1:0",
      0,
    ) as { region?: string };

    expect(model).toBeInstanceOf(ChatBedrockConverse);
    expect(model.region).toBe("us-east-1");
  });

  test("does not treat a lone access key (no secret) as static credentials", () => {
    process.env[BEDROCK_ACCESS_KEY] = "AKIAEXAMPLE";
    process.env[AWS_REGION_KEY] = "us-west-2";

    // Should not throw despite the secret key being absent — falls back to
    // the AWS default credential chain instead of using a half-set pair.
    expect(() =>
      createModel("bedrock", "anthropic.claude-sonnet-5-20260101-v1:0", 0),
    ).not.toThrow();
  });

  test("prefers BEDROCK_AWS_REGION over AWS_REGION over AWS_DEFAULT_REGION", () => {
    process.env[AWS_DEFAULT_REGION_KEY] = "sa-east-1";
    process.env[AWS_REGION_KEY] = "eu-central-1";
    process.env[BEDROCK_REGION] = "ap-southeast-2";

    const model = createModel(
      "bedrock",
      "anthropic.claude-sonnet-5-20260101-v1:0",
      0,
    ) as { region?: string };

    expect(model.region).toBe("ap-southeast-2");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
