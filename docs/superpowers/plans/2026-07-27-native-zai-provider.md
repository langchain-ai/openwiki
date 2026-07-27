# Native Z.AI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Z.AI as an independent, credential-isolated OpenWiki provider, replacing the wrapper-only request handling and operational safety in upstream TypeScript code.

**Architecture:** `zai` is a normal `OpenWikiProvider` with its own `ZAI_*` configuration and a provider-local `ChatOpenAI` fetch adapter. A reusable PID-symlink lock module owns execution and bundled-skill synchronization; it is invoked from the OpenWiki runtime rather than a launcher or preload hook. The adapter and locking layer accept time/fetch/filesystem boundaries as dependencies so all behavioral tests run without real Z.AI credentials or network access.

**Tech Stack:** Node.js 22, TypeScript ESM, Vitest, `@langchain/openai`, Node `fs/promises`.

## Global Constraints

- `OPENWIKI_PROVIDER=zai` is a distinct provider; it uses only `ZAI_API_KEY`, `ZAI_BASE_URL`, and `ZAI_RATE_LIMIT_*` settings.
- The default Z.AI API root is `https://api.z.ai/api/coding/paas/v4`; its default model is `glm-5.2`.
- Never modify `node_modules`, install a preload hook, replace `globalThis.fetch`, print a credential, or place a credential in source, tests, or docs.
- Preserve OpenAI-compatible, OpenRouter, and every other provider's current request and credential behavior.
- Do not hand-edit generated `openwiki/` pages. Update only source-controlled product docs such as `README.md` if provider usage documentation is needed.
- The existing upstream Mermaid baseline timeouts are outside this change; record them separately when running the final suite.

---

### Task 1: Register the independent provider and its configuration surface

**Files:**

- Modify: `src/constants.ts:1-852`
- Modify: `src/env.ts:1-566`
- Modify: `src/credentials.tsx:500-3700`
- Modify: `src/cli.tsx:400-720`
- Modify: `test/constants.test.ts:1-679`
- Modify: `test/env-behavior.test.ts:1-446`
- Modify: `test/credentials.test.ts:1-340`
- Modify: `test/startup.test.ts:1-322`

**Interfaces:**

- Produces `OpenWikiProvider = ... | "zai"`, `ZAI_API_KEY_ENV_KEY`, `ZAI_BASE_URL_ENV_KEY`, and rate-limit env-key constants.
- Produces `providerOffersOptionalBaseUrl(provider)` so Z.AI setup can accept an empty base URL and retain the built-in root.
- Produces `getCredentialDiagnostics({ provider?: OpenWikiProvider })`, where a selected provider returns universal config fields plus that provider's credential family, never unrelated provider secrets.

- [ ] **Step 1: Write the provider contract tests before adding production values.**

```ts
expect(normalizeProvider(" ZAI ")).toBe("zai");
expect(resolveConfiguredProvider({ OPENWIKI_PROVIDER: "zai" })).toBe("zai");
expect(getDefaultModelId("zai")).toBe("glm-5.2");
expect(resolveProviderBaseUrl("zai", {})).toBe(
  "https://api.z.ai/api/coding/paas/v4",
);
expect(
  getMissingProviderEnvKey("zai", {
    OPENROUTER_API_KEY: "not-a-zai-key",
    OPENAI_COMPATIBLE_API_KEY: "not-a-zai-key",
  }),
).toBe("ZAI_API_KEY");
```

Add environment and startup tests that save/select `zai`, prove `ZAI_API_KEY` is masked, and prove a non-interactive run with an explicit Z.AI provider fails with `ZAI_API_KEY` before agent/network creation. Add a diagnostics test that selects `zai` and asserts `ZAI_API_KEY`/`ZAI_BASE_URL` are present while `OPENROUTER_API_KEY` and `OPENAI_COMPATIBLE_API_KEY` are absent.

- [ ] **Step 2: Run the focused red tests.**

Run: `pnpm exec vitest run test/constants.test.ts test/env-behavior.test.ts test/credentials.test.ts test/startup.test.ts`

Expected: new Z.AI assertions fail because `zai` and the `ZAI_*` configuration surface do not yet exist; unrelated existing tests remain green.

- [ ] **Step 3: Add the minimal provider metadata and generic setup/diagnostic hooks.**

```ts
zai: {
  apiKeyEnvKey: ZAI_API_KEY_ENV_KEY,
  baseURL: ZAI_DEFAULT_BASE_URL,
  baseUrlEnvKey: ZAI_BASE_URL_ENV_KEY,
  optionalBaseUrl: true,
  label: "Z.AI",
  modelOptions: [{ id: "glm-5.2", label: "GLM 5.2" }],
}
```

Add `zai` to the explicit selectable list and key-based provider detection. Extend `MANAGED_ENV_KEYS`, non-secret base-URL handling, base-URL validation dispatch, and provider-filtered credential diagnostics. Make the wizard show an optional Z.AI base URL step: blank input advances without saving a key; a non-empty valid root saves `ZAI_BASE_URL`. Keep `OPENWIKI_PROVIDER` and `OPENWIKI_MODEL_ID` as universal setup fields, but never read, copy, display, or fall back to OpenRouter/OpenAI-compatible credentials while Z.AI is active.

- [ ] **Step 4: Run the focused provider tests to green.**

Run: `pnpm exec vitest run test/constants.test.ts test/env-behavior.test.ts test/credentials.test.ts test/startup.test.ts`

Expected: Z.AI is selectable, defaults to GLM 5.2 and the Coding API root, requires `ZAI_API_KEY` independently, and diagnostics redact only the selected provider's credential family.

### Task 2: Build the provider-local Z.AI request transport

**Files:**

- Create: `src/agent/zai-transport.ts`
- Modify: `src/agent/index.ts:650-760`
- Create: `test/zai-transport.test.ts`

**Interfaces:**

- Produces `createZaiFetch(dependencies?)`, a `fetch`-compatible function used only by the Z.AI `ChatOpenAI` client.
- Produces `normalizeZaiRequestBody(body)` and `resolveZaiRateLimitConfig(env)` for direct, network-free behavior tests.
- `ZaiTransportDependencies` contains injected `fetch`, `sleep`, `now`, and `env` values; production defaults are `globalThis.fetch`, `setTimeout`, `Date.now`, and `process.env`.

- [ ] **Step 1: Write failing transport behavior tests.**

```ts
const fetch = createZaiFetch({ env, fetch: fetchStub, sleep, now: () => now });
await fetch("https://api.z.ai/api/coding/paas/v4/chat/completions", {
  body: JSON.stringify({
    messages: [{ content: [{ type: "file", data: "aGVsbG8=" }] }],
  }),
});
expect(JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body))).toMatchObject({
  messages: [{ content: [{ type: "text", text: "hello" }] }],
});
```

Cover the complete file matrix: base64 UTF-8, ordinary string, invalid UTF-8 binary (`[binary file content omitted]`), empty/missing data (`[file content omitted]`), non-file blocks, malformed JSON, and non-Z.AI adapter isolation. Cover 429 delay precedence for integer seconds and HTTP-date `Retry-After`, exponential fallback/cap, disabled retries (`ZAI_RATE_LIMIT_MAX_RETRIES=0`), and exhaustion returning the final original 429. Assert recorded delays and returned responses, not mock call counts alone.

- [ ] **Step 2: Run the new test file and observe the red state.**

Run: `pnpm exec vitest run test/zai-transport.test.ts`

Expected: FAIL because the transport module and factory do not exist.

- [ ] **Step 3: Implement the isolated adapter and wire it only into Z.AI model construction.**

```ts
if (provider === "zai") {
  return new ChatOpenAI({
    apiKey: getProviderApiKey(provider),
    configuration: {
      baseURL: resolveProviderBaseUrl(provider),
      fetch: createZaiFetch(),
    },
    model: modelId,
    ...retryOptions,
  });
}
```

The adapter parses only JSON string bodies emitted by this Z.AI client. It maps only `messages[].content[]` blocks where `type === "file"`; all other body fields, non-file blocks, and malformed/non-JSON bodies retain their original representation. It retries only `response.status === 429`, uses `Retry-After` before exponential delay, caps all waits at `ZAI_RATE_LIMIT_MAX_DELAY_MS`, and never uses a process-wide patch.

- [ ] **Step 4: Verify the adapter and existing provider isolation.**

Run: `pnpm exec vitest run test/zai-transport.test.ts test/constants.test.ts test/startup.test.ts`

Expected: PASS; Z.AI behavior is fully deterministic with injected dependencies and no OpenRouter/OpenAI-compatible credential is read for an explicit `zai` provider.

### Task 3: Move scoped execution locking into the native runtime

**Files:**

- Create: `src/execution-lock.ts`
- Modify: `src/openwiki-home.ts:1-78`
- Modify: `src/agent/index.ts:109-224`
- Modify: `src/cli.tsx:710-720,4169-4176`
- Create: `test/execution-lock.test.ts`

**Interfaces:**

- Produces `withOpenWikiExecutionLock(scope, run, dependencies?)` and `OpenWikiLockError` with `exitCode = 73` for a malformed/non-symlink lock path.
- `ExecutionLockScope` is `{ command, cwd, outputMode }`; repository scopes derive their key from `realpath(cwd)`, personal scopes share one key, and `init` also acquires the shared-home setup lock.
- Production lock paths live under `~/.openwiki/locks/`; callers release only their own PID symlink in reverse acquisition order.

- [ ] **Step 1: Write red lock-manager tests using temporary lock directories.**

```ts
await Promise.all([
  withOpenWikiExecutionLock(repositoryScope(repoA), () => hold("first"), deps),
  withOpenWikiExecutionLock(repositoryScope(repoB), () => hold("second"), deps),
]);
expect(events.slice(0, 2)).toEqual(["first:start", "second:start"]);
```

Add separate tests proving same repository serializes, an on-disk directory symlink resolves to that same repository key, personal runs serialize, `init` waits only on another home-setup operation while an unrelated normal repository run overlaps, a dead numeric PID symlink is recovered, and a regular file/non-numeric symlink rejects with `OpenWikiLockError` exit code 73.

- [ ] **Step 2: Run the lock tests and observe the red state.**

Run: `pnpm exec vitest run test/execution-lock.test.ts`

Expected: FAIL because the native lock manager does not exist.

- [ ] **Step 3: Implement the PID-symlink manager and runtime/CLI integration.**

```ts
await withOpenWikiExecutionLock(
  { command, cwd: runtimeCwd, outputMode: options.outputMode ?? "local-wiki" },
  async () => runOpenWikiAgentUnlocked(command, runtimeCwd, options),
);
```

Create `openWikiLocksDir`; acquire with an atomic `symlink(String(process.pid), lockPath)`, validate a conflicting path with `lstat`/`readlink`, remove only dead numeric PID owners, and wait for live owners. Use SHA-256 of the physical repository path for a code lock filename. Convert `OpenWikiLockError` to exit 73 in both non-interactive print and auto-exiting interactive error handling; all other errors retain exit 1.

- [ ] **Step 4: Verify lock behavior.**

Run: `pnpm exec vitest run test/execution-lock.test.ts test/startup.test.ts`

Expected: PASS; normal code repositories overlap, contended physical repositories/personal runs serialize, and unsafe lock files never get deleted or treated as valid locks.

### Task 4: Make bundled-skill synchronization race-safe with the same native lock discipline

**Files:**

- Modify: `src/agent/skills.ts:1-32`
- Modify: `test/skills.test.ts:1-88`

**Interfaces:**

- `syncBundledSkills()` remains the production API and becomes in-process single-flight.
- `replaceSkillDirectories(sourceDir, targetDir, dependencies?)` accepts test-only-injected copy/sleep operations and retries only `EEXIST`/`ENOENT` copy races at 250ms, 500ms, and 750ms.
- The cross-process bundled-skill lock is a PID symlink under `~/.openwiki/locks/bundled-skills.lock` and shares malformed/stale-owner semantics with Task 3.

- [ ] **Step 1: Add failing race and preservation tests.**

```ts
await expect(
  replaceSkillDirectories(source, target, {
    copy: vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("race"), { code: "EEXIST" }),
      )
      .mockResolvedValue(undefined),
    sleep,
  }),
).resolves.toBeUndefined();
expect(delays).toEqual([250]);
```

Add a complementary `ENOENT` retry test, an `EACCES` immediate-failure test, and concurrent `syncBundledSkills` coverage that proves bundled directories update while a user-created unrelated skill remains untouched.

- [ ] **Step 2: Run the skills tests and observe the red state.**

Run: `pnpm exec vitest run test/skills.test.ts`

Expected: new race/single-flight assertions fail because current synchronization copies directories concurrently without retry or cross-process ownership.

- [ ] **Step 3: Implement in-process serialization, cross-process locking, and bounded retries.**

```ts
const sync = pendingSkillSync.then(() =>
  withBundledSkillLock(syncBundledSkillsOnce),
);
pendingSkillSync = sync.catch(() => undefined);
return sync;
```

Copy bundled skill directories one at a time, remove only the matching bundled target, preserve unrelated target entries, and retry only transient destination races. Reuse Task 3's owner validation and release behavior rather than duplicating PID-lock parsing.

- [ ] **Step 4: Verify the focused safety suite.**

Run: `pnpm exec vitest run test/skills.test.ts test/execution-lock.test.ts`

Expected: PASS; synchronization is safe within one process and across lock owners, preserves user skills, and propagates non-transient filesystem errors.

### Task 5: Run product checks and an opt-in credential-redacted Z.AI smoke test

**Files:**

- Modify only if the preceding checks reveal a tested defect.

- [ ] **Step 1: Run static and formatting checks.**

Run: `pnpm typecheck && pnpm lint:check && pnpm format:check`

Expected: exit 0 with no formatter or TypeScript errors.

- [ ] **Step 2: Run all focused provider and safety tests.**

Run: `pnpm exec vitest run test/constants.test.ts test/env-behavior.test.ts test/credentials.test.ts test/startup.test.ts test/zai-transport.test.ts test/execution-lock.test.ts test/skills.test.ts`

Expected: exit 0.

- [ ] **Step 3: Run the complete Vitest suite and separate known baseline failures.**

Run: `pnpm test`

Expected: all Z.AI and safety suites pass. If `test/index-middleware.test.ts` and `test/mermaid-validate.test.ts` still exceed their 5-second timeout, report them as the pre-existing baseline failures approved as separate work; do not modify them in this branch.

- [ ] **Step 4: Execute an opt-in smoke test only when an externally supplied key is present.**

```sh
if [ -n "${ZAI_API_KEY:-}" ]; then
  ZAI_API_KEY="$ZAI_API_KEY" \
  OPENWIKI_PROVIDER=zai \
  OPENWIKI_MODEL_ID=glm-5.2 \
  pnpm dev -- --print "Report the active provider and model only."
else
  echo "Z.AI smoke skipped: ZAI_API_KEY was not supplied."
fi
```

Run it from a disposable temporary repository, capture only provider/model/exit evidence, and never echo the key, full environment, request authorization, or generated content. Expected live evidence when opted in: `provider: Z.AI` and `model: glm-5.2`, with no OpenRouter request. If no external key is present, record the smoke as deliberately skipped rather than fabricated.

## Plan Self-Review

- Coverage: Tasks 1-2 cover the independent Z.AI identity, credential boundary, transport normalization, retry contract, setup, and diagnostics. Tasks 3-4 migrate the wrapper's execution and bundled-skill safety. Task 5 covers required static, suite, and opt-in live verification.
- Placeholder scan: every production boundary, test file, command, expected outcome, and required injected dependency is named.
- Consistency: `zai`, `ZAI_API_KEY`, `ZAI_BASE_URL`, `glm-5.2`, and the Coding API root are used consistently; only the Z.AI transport receives the custom fetch adapter.
