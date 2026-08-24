---
type: Reference
title: Authentication
description: How OpenWiki authenticates connector OAuth providers and model providers — the provider registry, browser PKCE flow, lazy token refresh, secure OAuth discovery, and external-CLI credential reuse.
tags: [auth, oauth, pkce, tokens, providers]
sources:
  - id: openwiki-source-7551641210d49d6e1afc59ae
    resource: repo://src/auth/configure.ts
  - id: openwiki-source-8a4d154074ac83bc638a4d89
    resource: repo://src/auth/external-cli-auth.ts
  - id: openwiki-source-d0f4a1a2be091b271c3d3002
    resource: repo://src/auth/oauth-discovery.ts
  - id: openwiki-source-278e707c2c172a73e5252cde
    resource: repo://src/auth/oauth.ts
  - id: openwiki-source-3ce148930eaa48d0e21b72d3
    resource: repo://src/auth/providers.ts
  - id: openwiki-source-aa47a7769472ab8bf5ec822d
    resource: repo://src/auth/tokens.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-22T08:02:55.052Z" }
verified:
  - by: openwiki/0.3.3
    at: 2026-08-22T08:02:55.052Z
---

# Authentication

OpenWiki authenticates two different things: **connector OAuth providers** (Gmail, Notion, Slack, X) that grant access to personal data sources, and **model providers**, some of which reuse an external CLI's session. All persisted auth values are written into the OpenWiki home `.env` through the shared env store rather than any provider-specific location.

## Connector OAuth providers

Connector OAuth providers are declared in a single `AUTH_PROVIDERS` registry that maps each to its authorization/token endpoints, client-auth style, scopes, and the env-var names its tokens are written to.

`runOAuthAuth` performs a browser **Authorization Code + PKCE** flow:

```mermaid
sequenceDiagram
    participant CLI
    participant Browser
    participant Provider
    CLI->>CLI: start loopback callback server (127.0.0.1)
    CLI->>CLI: generate state + code verifier/challenge
    CLI->>Provider: build authorization URL
    Browser->>Provider: user authorizes
    Provider->>CLI: redirect with code (to loopback)
    CLI->>Provider: exchange code + verifier for tokens
    CLI->>CLI: persist tokens to ~/.openwiki/.env
```

_Browser PKCE OAuth flow._

Token access is **lazy and refreshed on demand**: a cached access token is reused unless expired, otherwise refreshed via the provider's refresh token, using an expiry skew so it refreshes slightly early. OAuth discovery fetches protected-resource and authorization-server metadata from well-known endpoints, validating every candidate URL before fetching so discovery cannot be redirected to an arbitrary host.

## Model provider credentials

Some model providers authenticate by reusing an **external CLI's session**, resolving a token by invoking that CLI with a timeout. For the GitHub CLI the hostname is derived from the provider base URL so a reused session targets the correct GitHub tenant.

`configureAuthProvider` writes a connector config for a provider and, unless `--force` is set, leaves an existing config untouched and reports it as `exists`.

For onboarding and credential collection, see [onboarding.md](onboarding.md). For ChatGPT OAuth model access specifically, see [agent/model-providers.md](../agent/model-providers.md).
