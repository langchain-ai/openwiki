## Why

OpenWiki supports many LLM providers but not IBM Bob, which IBM teams already have access to through their subscription. Adding Bob as a first-class provider lets IBM users run OpenWiki against their existing Bob inference credits without configuring a separate API key from another vendor. IBM users also benefit from having OpenWiki installable as an MCP server directly inside Bob, so they can invoke wiki generation from the coding agent they already use daily.

## What Changes

- Add `"bob"` to the `OpenWikiProvider` union type
- Add `BOB_API_KEY_ENV_KEY` and `BOB_BASE_URL_ENV_KEY` constants
- Add a `bob` entry in `PROVIDER_CONFIGS` with the correct base URL, auth scheme, model list, and User-Agent requirement
- Add `BOB_API_KEY_ENV_KEY` to `MANAGED_ENV_KEYS` and `CREDENTIAL_DIAGNOSTIC_ENV_KEYS` in `env.ts`
- Override the `Authorization` header scheme to `Apikey` (Bob uses `Apikey <token>`, not `Bearer <token>`)
- Override the `User-Agent` header (Cloudflare blocks unknown agents on the `/inference/` path)
- Handle Bob's non-standard model discovery endpoint (`/inference/v1/model/info` instead of `/v1/models`)
- Add Bob to the credential setup UI flow
- Add `"bob"` to `HostTargetId` and `HOST_TARGETS` in the integration registry
- Bob MCP config paths: `~/.bob/mcp.json` (user scope) and `.bob/mcp.json` (project scope)
- Bob uses the existing `"json"` config adapter — no new parser needed

## Capabilities

### New Capabilities

- `providers/bob`: IBM Bob as a selectable LLM provider — authentication, model list, request routing, and credential setup
- `integrations/bob`: IBM Bob as a supported coding agent host for MCP server installation

### Modified Capabilities

- `providers/model-availability`: Bob's model discovery uses `/model/info` (a custom JSON shape) rather than the standard OpenAI `/models` endpoint; the availability check must skip or adapt for Bob

## Impact

- `src/config/constants.ts` — `OpenWikiProvider` union, `PROVIDER_CONFIGS`, new env key constants
- `src/config/env.ts` — `MANAGED_ENV_KEYS`, `CREDENTIAL_DIAGNOSTIC_ENV_KEYS`
- `src/agent/index.ts` — `createModel()` new branch for Bob (custom auth header + User-Agent injection)
- `src/model-availability.ts` — skip standard model-list check for Bob, or add a Bob-specific check
- `src/setup/` — credential setup UI for the new provider
- `src/integrations/install/types.ts` — `HostTargetId` union
- `src/integrations/install/registry.ts` — `HOST_TARGETS` record
- `integrations/openwiki/agents/bob.yaml` — new Bob agent descriptor (alongside existing `openai.yaml`)
- No new npm dependencies
