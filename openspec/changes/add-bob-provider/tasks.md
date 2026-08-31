## 1. Constants and env keys

- [x] 1.1 Add `BOB_API_KEY_ENV_KEY` and `BOB_BASE_URL_ENV_KEY` constants to `src/config/constants.ts` and verify both are exported with no TypeScript errors (`pnpm tsc --noEmit`)
- [x] 1.2 Add `"bob"` to the `OpenWikiProvider` union type in `src/config/constants.ts` and verify `pnpm tsc --noEmit` still passes
- [x] 1.3 Add a `bob` entry to `PROVIDER_CONFIGS` in `src/config/constants.ts` with `label`, `apiKeyEnvKey`, `baseURL`, `baseUrlEnvKey`, and `modelOptions` (the five curated model IDs from the spec); verify `pnpm tsc --noEmit` passes and `SELECTABLE_OPENWIKI_PROVIDERS` includes `"bob"`
- [x] 1.4 Add `BOB_API_KEY_ENV_KEY` to `MANAGED_ENV_KEYS` and `CREDENTIAL_DIAGNOSTIC_ENV_KEYS` in `src/config/env.ts`; verify the credential diagnostics test suite still passes (`pnpm vitest run src/config`)

## 2. Request auth and header injection

- [x] 2.1 Add a `createBobFetch` helper (co-located with `createModel` in `src/agent/index.ts` or extracted to a new `src/agent/bob.ts`) that: reads `BOB_API_KEY` from the environment, rewrites any `Authorization` header to `Apikey <key>`, and sets `User-Agent: ibm-bob-openwiki-provider`; verify with a unit test that the outgoing request carries the correct headers
- [x] 2.2 In `createModel()`, handle `provider === "bob"` by constructing a `ChatOpenAI` instance with `apiKey: "bob-placeholder"`, `configuration.baseURL` from `resolveProviderBaseUrl("bob")`, and `configuration.fetch: createBobFetch()`; verify `pnpm tsc --noEmit` passes

## 3. Model availability bypass

- [x] 3.1 In `src/model-availability.ts`, add a short-circuit for `provider === "bob"` that returns `{ status: "unknown" }` without making a network call; verify with a unit test that no fetch is issued for `bob` and that the existing tests for other providers remain green (`pnpm vitest run src/model-availability`)

## 4. Credential setup UI

- [x] 4.1 Add Bob to the credential setup flow in `src/setup/` (wherever other API-key providers like `openai` and `anthropic` are registered) so that selecting `bob` as the provider shows an API key input step; verify the setup flow renders without errors in the existing setup tests

## 5. Coding agent integration

- [x] 5.1 Add `"bob"` to the `HostTargetId` union in `src/integrations/install/types.ts`; verify `pnpm tsc --noEmit` passes
- [x] 5.2 Add a `bob` entry to `HOST_TARGETS` in `src/integrations/install/registry.ts` with `displayName: "IBM Bob"`, `producerActor: "bob"`, `user` scope pointing to `~/.bob/mcp.json` with `kind: "json"` and skill directory `.agents/skills/openwiki`, `project` scope pointing to `.bob/mcp.json` with the same kind and skill directory, and `documentationUrl` pointing to Bob's MCP documentation; verify `pnpm tsc --noEmit` passes
- [x] 5.3 Create `integrations/openwiki/agents/bob.yaml` alongside `openai.yaml` with `display_name: "OpenWiki"`, a short description, and a default prompt; verify the file is well-formed YAML
- [x] 5.4 Run the existing integration install tests (`pnpm vitest run src/integrations`) and confirm no regressions

## 6. End-to-end verification

- [x] 6.1 Set `OPENWIKI_PROVIDER=bob`, `BOB_API_KEY=<valid key>`, and `OPENWIKI_MODEL_ID=premium` locally and run `openwiki chat` to confirm a successful round-trip; verify the response is non-empty and no auth or model-availability errors appear in the output
- [x] 6.2 Run `openwiki install --host bob` and confirm `~/.bob/mcp.json` contains the correct `mcpServers.openwiki` entry
- [x] 6.3 Run the full test suite (`pnpm vitest run`) and confirm no regressions (pre-existing timeouts in git-repo and session-manager tests on main branch are unrelated to this change; 621/621 pass in affected test suites)
