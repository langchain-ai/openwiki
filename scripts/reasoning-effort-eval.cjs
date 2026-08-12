#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { cp, mkdir, readFile, readdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const process = require("node:process");
const { clearInterval, setInterval } = require("node:timers");

const repoRoot = path.resolve(__dirname, "..");
const fixtureRoot = path.join(
  repoRoot,
  "scripts",
  "fixtures",
  "reasoning-effort-sample",
);
const evaluationPrompt = `Review this complete one-file JavaScript repository:

\`\`\`js
export function admitRequests(times, { capacity, refillEveryMs }) {
  let tokens = capacity;
  let lastRefillMs = 0;

  return times.map((now) => {
    const elapsed = now - lastRefillMs;
    const refillCount = Math.floor(elapsed / refillEveryMs);
    if (refillCount > 0) {
      tokens = Math.min(capacity, tokens + refillCount);
      lastRefillMs += refillCount * refillEveryMs;
    }

    const accepted = tokens > 0;
    if (accepted) tokens -= 1;
    return { atMs: now, accepted, tokens };
  });
}
\`\`\`

For capacity 2, refillEveryMs 1000, and times [0, 900, 1900, 2000]:
1. Derive both the accepted values and post-decision token values returned by the current code.
2. Derive both arrays again if lastRefillMs += refillCount * refillEveryMs is changed to lastRefillMs = now.
3. Identify the first accepted-value divergence, explain the lost partial refill time, and give one exact regression assertion.

Start with exactly one compact JSON line using this shape:
{"current":{"accepted":[],"tokens":[]},"modified":{"accepted":[],"tokens":[]},"firstAcceptedDivergenceMs":0}

Be concise. Do not use tools. Do not use an em dash.`;
const initPrompt =
  "Initialize documentation for this small token-bucket rate limiter. Focus on its public API, refill invariant, and test command.";
const chatPrompt =
  "Using the generated OpenWiki as your primary source, trace admitRequests for [0, 900, 1900, 2000] with capacity 2 and refillEveryMs 1000, explain the refill invariant, and give the focused test command. Do not modify files.";

function parseArgs(argv) {
  const args = {
    efforts: ["low", "high"],
    lifecycleEffort: "high",
    maxTokens: 768,
    outputDir: null,
    provider: "nvidia",
    model: null,
    skipLifecycle: true,
    skipProbes: false,
    timeoutMs: 180_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--skip-lifecycle") {
      args.skipLifecycle = true;
      continue;
    }
    if (arg === "--include-lifecycle") {
      args.skipLifecycle = false;
      continue;
    }
    if (arg === "--skip-probes") {
      args.skipProbes = true;
      continue;
    }
    if (!next) {
      throw new Error(`${arg} requires a value.`);
    }
    if (arg === "--provider") {
      args.provider = next;
    } else if (arg === "--model") {
      args.model = next;
    } else if (arg === "--efforts") {
      args.efforts = next.split(",").map((value) => value.trim());
    } else if (arg === "--lifecycle-effort") {
      args.lifecycleEffort = next;
    } else if (arg === "--max-tokens") {
      args.maxTokens = Number(next);
    } else if (arg === "--output-dir") {
      args.outputDir = path.resolve(next);
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number(next);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
    index += 1;
  }

  if (!["openai", "openai-chatgpt", "nvidia"].includes(args.provider)) {
    throw new Error("--provider must be openai, openai-chatgpt, or nvidia.");
  }
  if (args.efforts.length < 1 || args.efforts.some((value) => !value)) {
    throw new Error("--efforts must contain at least one value.");
  }
  if (!Number.isInteger(args.maxTokens) || args.maxTokens < 1) {
    throw new Error("--max-tokens must be a positive integer.");
  }
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1) {
    throw new Error("--timeout-ms must be a positive integer.");
  }
  if (args.skipLifecycle && args.skipProbes) {
    throw new Error("--skip-lifecycle and --skip-probes cannot be combined.");
  }

  args.model ??=
    args.provider === "nvidia"
      ? "nvidia/nemotron-3-super-120b-a12b"
      : "gpt-5.6-luna";
  args.outputDir ??= path.join(
    repoRoot,
    "artifacts",
    "reasoning-effort",
    `${args.provider}-${new Date().toISOString().replaceAll(":", "-")}`,
  );

  return args;
}

function printHelp() {
  process.stdout.write(`Usage:
  pnpm eval:reasoning-effort -- [options]

Options:
  --provider <id>           openai, openai-chatgpt, or nvidia
  --model <id>              model id (provider-specific default when omitted)
  --efforts <csv>           probe efforts to compare (default: low,high)
  --max-tokens <count>      model maxTokens value per probe (default: 768)
  --timeout-ms <ms>         timeout per probe (default: 180000)
  --lifecycle-effort <id>   effort for sample init and chat (default: high)
  --output-dir <path>       artifact directory (default: artifacts/reasoning-effort/...)
  --skip-lifecycle          run only the fast micro-fixture probes (default)
  --include-lifecycle       also run full OpenWiki init and chat (slow)
  --skip-probes             run only the sample init and chat lifecycle

Credentials are read through OpenWiki's normal environment loading. The script
never prints credential values. Results are observational: it records provider
usage metadata but does not assert that a higher effort must consume more tokens.
The default mode uses a one-function fixture and runs effort probes serially so
the process-wide effort environment stays isolated. Full init is opt-in because
its critic and QA agents can take minutes.
`);
}

function textContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) =>
      block && typeof block === "object" && typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("");
}

function reasoningContent(message) {
  const value = message.additional_kwargs?.reasoning_content;
  return typeof value === "string" ? value : "";
}

function usageRecord(message) {
  const usage = message.usage_metadata ?? {};
  return {
    inputTokens: numberOrNull(usage.input_tokens),
    outputTokens: numberOrNull(usage.output_tokens),
    reasoningTokens: numberOrNull(usage.output_token_details?.reasoning),
    totalTokens: numberOrNull(usage.total_tokens),
  };
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatNumber(value) {
  return value === null ? "not reported" : String(value);
}

function delta(left, right) {
  return left === null || right === null ? null : right - left;
}

async function withProgress(label, operation) {
  const startedAt = Date.now();
  const progress = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1_000);
    process.stdout.write(`${label}: still running (${elapsedSeconds}s)\n`);
  }, 15_000);

  try {
    return await operation();
  } finally {
    clearInterval(progress);
  }
}

async function runProbe(createModel, args, effort) {
  process.stdout.write(`Starting micro-fixture chat (${effort})\n`);
  process.env.OPENWIKI_PROVIDER = args.provider;
  process.env.OPENWIKI_MODEL_ID = args.model;
  process.env.OPENWIKI_REASONING_EFFORT = effort;

  const model = createModel(args.provider, args.model, 0);
  model.maxTokens = args.maxTokens;
  const startedAt = Date.now();
  const message = await withProgress(`Token probe (${effort})`, () =>
    model.invoke(evaluationPrompt, {
      signal: globalThis.AbortSignal.timeout(args.timeoutMs),
    }),
  );
  const response = textContent(message.content);
  const reasoning = reasoningContent(message);
  const result = {
    durationMs: Date.now() - startedAt,
    effort,
    ...usageRecord(message),
    reasoningContentChars: reasoning.length,
    response,
    responseChars: response.length,
  };

  const expectsReasoning = !["none", "default", "provider-default"].includes(
    effort,
  );
  const hasReasoningEvidence =
    (result.reasoningTokens ?? 0) > 0 || result.reasoningContentChars > 0;
  if (expectsReasoning && !hasReasoningEvidence) {
    throw new Error(
      `${args.provider}/${args.model} returned no reasoning evidence for effort ${effort}`,
    );
  }
  const compactResponse = response.replaceAll(/\s+/gu, "");
  const expectedEvidence = [
    '"current":{"accepted":[true,true,true,true],"tokens":[1,0,0,0]}',
    '"modified":{"accepted":[true,true,true,false],"tokens":[1,0,0,0]}',
    '"firstAcceptedDivergenceMs":2000',
  ];
  if (!expectedEvidence.every((value) => compactResponse.includes(value))) {
    throw new Error(
      `${args.provider}/${args.model} did not return the expected token-bucket trace for effort ${effort}`,
    );
  }
  result.semanticCheck = "pass";

  process.stdout.write(`::group::Micro-fixture chat result (${effort})\n`);
  process.stdout.write(
    `${JSON.stringify({
      provider: args.provider,
      model: args.model,
      ...result,
    })}\n`,
  );
  process.stdout.write("::endgroup::\n");
  return result;
}

async function prepareSample(outputDir) {
  const sampleDir = path.join(outputDir, "sample-project");
  await mkdir(outputDir, { recursive: true });
  await cp(fixtureRoot, sampleDir, { recursive: true });
  await runProcess("git", ["init", "--quiet"], sampleDir);
  await runProcess(
    "git",
    ["config", "user.name", "OpenWiki Evaluation"],
    sampleDir,
  );
  await runProcess(
    "git",
    ["config", "user.email", "openwiki-eval@example.invalid"],
    sampleDir,
  );
  await runProcess("git", ["add", "."], sampleDir);
  await runProcess(
    "git",
    ["commit", "--quiet", "-m", "test: add reasoning effort sample"],
    sampleDir,
  );
  return sampleDir;
}

async function runLifecycle(args) {
  const sampleDir = await prepareSample(args.outputDir);
  const env = {
    ...process.env,
    CI: process.env.CI ?? "",
    DO_NOT_TRACK: "1",
    LANGCHAIN_TRACING_V2: "false",
    LANGSMITH_API_KEY: "",
    OPENWIKI_MODEL_ID: args.model,
    OPENWIKI_PROVIDER: args.provider,
    OPENWIKI_PROVIDER_RETRY_ATTEMPTS: "1",
    OPENWIKI_REASONING_EFFORT: args.lifecycleEffort,
    OPENWIKI_TELEMETRY_DISABLED: "1",
  };
  const cli = path.join(repoRoot, "dist", "cli", "cli.js");

  process.stdout.write(
    `::group::Sample init (${args.lifecycleEffort})\nprovider=${args.provider}\nmodel=${args.model}\n`,
  );
  const init = await withProgress("Sample init", () =>
    runProcess(
      process.execPath,
      [
        cli,
        "--print",
        "--mode",
        "code",
        "--model-id",
        args.model,
        "--init",
        initPrompt,
      ],
      sampleDir,
      env,
    ),
  );
  await writeFile(path.join(args.outputDir, "init.stdout.log"), init.stdout);
  await writeFile(path.join(args.outputDir, "init.stderr.log"), init.stderr);
  process.stdout.write(
    `exit=0 durationMs=${init.durationMs} responseChars=${init.stdout.trim().length}\n::endgroup::\n`,
  );

  const generatedFiles = (
    await listFiles(path.join(sampleDir, "openwiki"))
  ).map((file) => path.relative(sampleDir, file));

  process.stdout.write(
    `::group::Sample chat (${args.lifecycleEffort})\nprovider=${args.provider}\nmodel=${args.model}\n`,
  );
  const chat = await withProgress("Sample chat", () =>
    runProcess(
      process.execPath,
      [cli, "--print", "--mode", "code", "--model-id", args.model, chatPrompt],
      sampleDir,
      env,
    ),
  );
  await writeFile(path.join(args.outputDir, "chat.stdout.log"), chat.stdout);
  await writeFile(path.join(args.outputDir, "chat.stderr.log"), chat.stderr);
  process.stdout.write(
    `exit=0 durationMs=${chat.durationMs} responseChars=${chat.stdout.trim().length}\n::endgroup::\n`,
  );

  return {
    chat: {
      durationMs: chat.durationMs,
      response: chat.stdout.trim(),
      responseChars: chat.stdout.trim().length,
    },
    effort: args.lifecycleEffort,
    generatedFiles,
    init: {
      durationMs: init.durationMs,
      response: init.stdout.trim(),
      responseChars: init.stdout.trim().length,
    },
  };
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function runProcess(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code,
        durationMs: Date.now() - startedAt,
        stderr,
        stdout,
      };
      if (code === 0) {
        resolve(result);
      } else {
        const detail = stderr.trim() || stdout.trim() || "no process output";
        reject(new Error(`${command} exited with ${code}: ${detail}`));
      }
    });
  });
}

function escapeTable(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function truncate(value, max = 1200) {
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;
}

function createSummary(args, probes, lifecycle) {
  const reproduceFlags = [
    `--provider ${args.provider}`,
    `--model ${args.model}`,
    ...(!args.skipProbes ? [`--efforts ${args.efforts.join(",")}`] : []),
    ...(!args.skipProbes ? [`--max-tokens ${args.maxTokens}`] : []),
    ...(!args.skipProbes ? [`--timeout-ms ${args.timeoutMs}`] : []),
    ...(!args.skipLifecycle
      ? [`--lifecycle-effort ${args.lifecycleEffort}`]
      : []),
    ...(!args.skipLifecycle ? ["--include-lifecycle"] : []),
    ...(args.skipProbes ? ["--skip-probes"] : []),
  ].join(" ");
  const sections = [
    "## Reasoning effort feature evaluation",
    "",
    `- Provider: \`${escapeTable(args.provider)}\``,
    `- Model: \`${escapeTable(args.model)}\``,
  ];

  if (probes.length > 0) {
    sections.push(
      "- Fixture: one JavaScript token-bucket function with no dependencies",
      "- Token comparison: one observation per effort with an identical prompt",
      `- Runtime guard: probes run serially with model maxTokens set to ${args.maxTokens} and a ${args.timeoutMs} ms timeout each`,
      "- Assertions: each active effort must return reasoning evidence and the expected current/modified traces with the first divergence at 2000 ms; token ordering is not asserted because model output is nondeterministic",
    );
    const rows = probes
      .map(
        (probe) =>
          `| ${probe.effort} | ${formatNumber(probe.inputTokens)} | ${formatNumber(probe.outputTokens)} | ${formatNumber(probe.reasoningTokens)} | ${probe.reasoningContentChars} | ${probe.durationMs} |`,
      )
      .join("\n");
    sections.push(
      "",
      "### Micro-fixture chat observation",
      "",
      "| Effort | Input tokens | Output tokens | Reasoning tokens | Reasoning content chars | Duration (ms) |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      rows,
    );

    for (const probe of probes) {
      sections.push(
        "",
        `<details><summary>${probe.effort} chat result</summary>`,
        "",
        "```text",
        truncate(probe.response, 600),
        "```",
        "</details>",
      );
    }
  }

  if (probes.length > 1) {
    const first = probes[0];
    const last = probes.at(-1);
    sections.push(
      "",
      `- Output token delta (${first.effort} -> ${last.effort}): ${formatNumber(delta(first.outputTokens, last.outputTokens))}`,
      `- Reasoning token delta (${first.effort} -> ${last.effort}): ${formatNumber(delta(first.reasoningTokens, last.reasoningTokens))}`,
    );
  }

  if (probes.some((probe) => probe.reasoningTokens === null)) {
    sections.push(
      "- Provider note: exact reasoning tokens were not reported separately for at least one response; output tokens and reasoning-content characters are shown without relabeling them as reasoning tokens.",
    );
  }

  if (lifecycle) {
    sections.push(
      "",
      `### Sample project lifecycle (effort: ${lifecycle.effort})`,
      "",
      `- Init: pass in ${lifecycle.init.durationMs} ms`,
      `- Chat: pass in ${lifecycle.chat.durationMs} ms`,
      `- Generated wiki files: ${lifecycle.generatedFiles.length}`,
      "",
      "<details>",
      "<summary>Generated files</summary>",
      "",
      ...lifecycle.generatedFiles.map((file) => `- \`${file}\``),
      "",
      "</details>",
      "",
      "<details>",
      "<summary>Init result</summary>",
      "",
      "```text",
      truncate(lifecycle.init.response),
      "```",
      "</details>",
      "",
      "<details>",
      "<summary>Chat result</summary>",
      "",
      "```text",
      truncate(lifecycle.chat.response),
      "```",
      "</details>",
    );
  }

  sections.push(
    "",
    "### Reproduce",
    "",
    "```sh",
    `pnpm eval:reasoning-effort -- ${reproduceFlags}`,
    "```",
    "",
  );
  return `${sections.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.outputDir, { recursive: true });
  const { loadOpenWikiEnv } = await import(
    path.join(repoRoot, "dist", "config", "env.js")
  );
  const { createModel } = await import(
    path.join(repoRoot, "dist", "agent", "index.js")
  );
  await loadOpenWikiEnv();

  const probes = [];
  if (!args.skipProbes) {
    for (const effort of args.efforts) {
      probes.push(await runProbe(createModel, args, effort));
    }
  }
  const lifecycle = args.skipLifecycle ? null : await runLifecycle(args);
  const report = {
    generatedAt: new Date().toISOString(),
    provider: args.provider,
    model: args.model,
    probes,
    lifecycle,
  };
  const summary = createSummary(args, probes, lifecycle);
  await writeFile(
    path.join(args.outputDir, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(path.join(args.outputDir, "summary.md"), summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const current = await readFile(
      process.env.GITHUB_STEP_SUMMARY,
      "utf8",
    ).catch(() => "");
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `${current}${summary}`);
  }

  process.stdout.write(`${summary}\nArtifacts: ${args.outputDir}\n`);
}

const keepAlive = setInterval(() => {}, 1_000);

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `::error::Reasoning effort evaluation failed: ${message}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => clearInterval(keepAlive));
