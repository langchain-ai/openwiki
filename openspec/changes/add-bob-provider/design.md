## Context

See `proposal.md — Why` for motivation.

OpenWiki's provider system is declarative: a `PROVIDER_CONFIGS` record in [`src/config/constants.ts`](../../../src/config/constants.ts) maps each provider ID to its label, env keys, base URL, model list, and auth method. `createModel()` in [`src/agent/index.ts`](../../../src/agent/index.ts) switches on the provider to build the right LangChain chat model. Most providers fall into one of five patterns — OpenAI-compat (default), Anthropic, Gemini, Bedrock, and OAuth — and the default "else" branch handles everything that fits the OpenAI wire format.

Bob does not fit the default branch cleanly for two reasons:

1. Its auth header scheme is `Apikey` not `Bearer`, and LangChain's `ChatOpenAI` always sends `Authorization: Bearer <apiKey>`.
2. Its Cloudflare WAF hard-blocks requests that don't carry a specific User-Agent (`ibm-bob-openwiki-provider`).

## Goals / Non-Goals

**Goals:**

- `OPENWIKI_PROVIDER=bob` + `BOB_API_KEY` works end-to-end (chat, update, init)
- API-key auth path only (no OAuth/IBMid browser login)
- Curated model list for the setup UI; custom model IDs still accepted
- Credential stored, diagnosed, and manageable through the same flows as other providers

**Non-Goals:**

- OAuth / IBMid login flow (the gateway plugin supports it, but it requires a separate browser-login implementation comparable to `openai-chatgpt`; defer)
- Instance/team routing headers (`x-instance-id` / `x-team-id`) for General key type (Inference keys don't need them; defer)
- Dynamic model discovery via `/model/info` (curated static list is sufficient to start)

## Decisions

### 1. Custom `fetch` wrapper rather than a new `createModel` branch

**Decision:** Implement Bob inside the existing "else" (OpenAI-compat) branch of `createModel()` by passing a custom `fetch` function to `ChatOpenAI` that rewrites the `Authorization` header and injects the `User-Agent`.

**Rationale:** Bob speaks OpenAI-compatible chat completions — the only differences are headers, not the wire protocol. A thin fetch wrapper keeps the change additive (no new switch branch) and makes it easy to unit-test header injection in isolation.

**Alternative considered:** Add a dedicated `if (provider === "bob")` branch like the `anthropic` or `openai-chatgpt` cases. Rejected because it would duplicate the OpenAI client construction for no protocol reason.

```
createModel("bob", modelId, ...)
        │
        ▼  (else branch)
  ChatOpenAI({
    apiKey: BOB_API_KEY_ENV_KEY placeholder,
    configuration: { baseURL, fetch: bobFetch },
    model: modelId,
    ...
  })
        │
        ▼  bobFetch(input, init)
  rewrites Authorization: Bearer → Authorization: Apikey <key>
  injects  User-Agent: ibm-bob-openwiki-provider
  delegates to globalThis.fetch
```

### 2. `apiKey` passed as a dummy, real key injected via `fetch`

**Decision:** Pass `apiKey: "bob-placeholder"` to `ChatOpenAI` and inject the real key inside the custom `fetch`. This avoids `ChatOpenAI` throwing "missing API key" while keeping the authorization logic self-contained in one place.

**Rationale:** `ChatOpenAI` validates that `apiKey` is non-empty but does not validate its format. Passing a placeholder silences the constructor check; the fetch wrapper replaces the Authorization header before the request hits the network.

### 3. Model availability check bypassed for Bob

**Decision:** In `src/model-availability.ts`, treat `bob` as a provider whose availability is always `"unknown"` (the existing safe fallback), rather than querying `/v1/models`.

**Rationale:** Bob exposes `/inference/v1/model/info` (a non-standard shape returning a `data` array), not the OpenAI `/v1/models` endpoint. Querying the wrong path returns an error, which the current code treats as the model being unavailable — incorrectly blocking a valid run. The `"unknown"` path already logs a debug message and continues, which is the right behavior until we add a Bob-specific availability check.

### 4. Static model list, no dynamic discovery at startup

**Decision:** Use a curated static model list in `PROVIDER_CONFIGS`. Skip dynamic `/model/info` polling at startup.

**Rationale:** Dynamic discovery at startup adds latency and a failure mode (what happens if the endpoint is slow or the key has no access?). The static list covers the standard tiers that Bob exposes to all subscribers. Custom model IDs can still be passed via `OPENWIKI_MODEL_ID`.

## Risks / Trade-offs

- **Model list staleness** → Mitigation: `OPENWIKI_MODEL_ID` override lets users use any model ID without waiting for a release; the static list can be updated cheaply in a future PR.
- **User-Agent coupling to gateway behavior** → Mitigation: `BOB_BASE_URL` override lets enterprise users point at a different Bob gateway that may not enforce the same UA rule. The UA is hardcoded for the default endpoint only via the custom fetch.
- **Header rewrite is invisible to LangChain retries** → The custom `fetch` runs on every attempt, so retries also carry the correct headers. No risk.
