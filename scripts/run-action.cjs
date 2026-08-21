const { spawn } = require("node:child_process");

const PROVIDER_ENV = Object.freeze({
  anthropic: {
    apiKey: "ANTHROPIC_API_KEY",
    baseUrl: "ANTHROPIC_BASE_URL",
  },
  baseten: {
    apiKey: "BASETEN_API_KEY",
    baseUrl: "BASETEN_BASE_URL",
  },
  bedrock: {
    apiKey: "BEDROCK_AWS_ACCESS_KEY_ID",
    region: "BEDROCK_AWS_REGION",
    secretKey: "BEDROCK_AWS_SECRET_ACCESS_KEY",
    sessionToken: "BEDROCK_AWS_SESSION_TOKEN",
  },
  copilot: {
    apiKey: "COPILOT_API_KEY",
    baseUrl: "COPILOT_BASE_URL",
  },
  fireworks: {
    apiKey: "FIREWORKS_API_KEY",
    baseUrl: "FIREWORKS_BASE_URL",
  },
  gemini: {
    apiKey: "GEMINI_API_KEY",
  },
  "gemini-enterprise": {
    location: "GOOGLE_CLOUD_LOCATION",
    project: "GOOGLE_CLOUD_PROJECT",
  },
  nebius: {
    apiKey: "NEBIUS_API_KEY",
  },
  nvidia: {
    apiKey: "NVIDIA_API_KEY",
    baseUrl: "NVIDIA_BASE_URL",
  },
  openai: {
    apiKey: "OPENAI_API_KEY",
    baseUrl: "OPENAI_BASE_URL",
  },
  "openai-chatgpt": {
    apiKey: "OPENAI_CHATGPT_ACCESS_TOKEN",
  },
  "openai-compatible": {
    apiKey: "OPENAI_COMPATIBLE_API_KEY",
    baseUrl: "OPENAI_COMPATIBLE_BASE_URL",
  },
  openrouter: {
    apiKey: "OPENROUTER_API_KEY",
  },
});

const PROVIDER_INPUTS = Object.freeze({
  apiKey: "INPUT_API_KEY",
  baseUrl: "INPUT_BASE_URL",
  location: "INPUT_LOCATION",
  project: "INPUT_PROJECT",
  region: "INPUT_REGION",
  secretKey: "INPUT_SECRET_KEY",
  sessionToken: "INPUT_SESSION_TOKEN",
});

const SHARED_INPUTS = Object.freeze({
  INPUT_LANGCHAIN_PROJECT: "LANGCHAIN_PROJECT",
  INPUT_LANGCHAIN_TRACING_V2: "LANGCHAIN_TRACING_V2",
  INPUT_LANGSMITH_API_KEY: "LANGSMITH_API_KEY",
  INPUT_MODEL_ID: "OPENWIKI_MODEL_ID",
  INPUT_OPENAI_COMPATIBLE_STREAMING: "OPENWIKI_OPENAI_COMPATIBLE_STREAMING",
  INPUT_OPENWIKI_LANGSMITH_API_KEY: "OPENWIKI_LANGSMITH_API_KEY",
});

const ACTION_INPUT_ENV_KEYS = Object.freeze([
  "INPUT_PROVIDER",
  ...Object.values(PROVIDER_INPUTS),
  ...Object.keys(SHARED_INPUTS),
]);

function assignIfPresent(target, key, value) {
  if (value !== undefined && value !== "") {
    target[key] = value;
  }
}

function createOpenWikiEnvironment(source = process.env) {
  const provider = source.INPUT_PROVIDER?.trim();
  if (provider === undefined || !Object.hasOwn(PROVIDER_ENV, provider)) {
    throw new Error(`Unsupported OpenWiki provider: ${provider || "(empty)"}`);
  }
  const providerEnv = PROVIDER_ENV[provider];

  const target = { ...source, OPENWIKI_PROVIDER: provider };
  for (const key of ACTION_INPUT_ENV_KEYS) {
    delete target[key];
  }

  for (const [field, inputKey] of Object.entries(PROVIDER_INPUTS)) {
    const outputKey = providerEnv[field];
    if (outputKey !== undefined) {
      assignIfPresent(target, outputKey, source[inputKey]);
    }
  }

  for (const [inputKey, outputKey] of Object.entries(SHARED_INPUTS)) {
    assignIfPresent(target, outputKey, source[inputKey]);
  }

  return target;
}

function runOpenWiki(source = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn("openwiki", ["code", "--update", "--print"], {
      env: createOpenWikiEnvironment(source),
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`OpenWiki exited after receiving ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (require.main === module) {
  runOpenWiki()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

module.exports = { createOpenWikiEnvironment, runOpenWiki };
