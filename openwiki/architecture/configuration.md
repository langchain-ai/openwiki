---
type: Reference
title: Configuration & OpenWiki Home
description: Where OpenWiki stores credentials and generated state, how OPENWIKI_CONFIG_DIR relocates the home directory, the permission model that protects secrets, and how the run loads its environment.
tags: [configuration, environment, credentials, security, filesystem]
sources:
  - id: openwiki-source-a953060a04ccefcf777de48e
    resource: repo://src/agent/index.ts
  - id: openwiki-source-7d433875b0854d0b8b951be0
    resource: repo://src/config/openwiki-home.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-22T08:02:55.052Z" }
verified:
  - by: openwiki/0.3.3
    at: 2026-08-22T08:02:55.052Z
---

# Configuration & OpenWiki Home

OpenWiki keeps all persistent user state in a single **home directory**. Configuration is resolved from this home plus `OPENWIKI_*` environment variables, and the run loads its credentials from the home `.env` before resolving a model provider.

## The OpenWiki home

The home directory defaults to `~/.openwiki`. It can be relocated by setting `OPENWIKI_CONFIG_DIR`, which supports leading-tilde expansion (`~` and `~/...`) because several environments that set env vars leave the tilde literal.

The home contains dedicated subdirectories, and the credentials `.env` lives at its root:

| Path                    | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `connectors/`           | Per-connector config, state, raw data, and logs |
| `conversation_history/` | Offloaded conversation history                  |
| `wiki/`                 | The local (personal) wiki                       |
| `skills/`               | Synced bundled skills                           |
| `.env`                  | Persisted credentials and settings              |

Per-connector paths are derived under `connectors/<connectorId>/` (`config.json`, `state.json`, `raw/`, `logs/`).

## Permission model

`ensureOpenWikiHome` creates the home and each subdirectory with `0700` permissions and applies a Windows ACL restriction so the directory is accessible only to the current user. Because the `.env` holding provider keys and OAuth tokens lives inside this tree, this permission model is the primary at-rest protection for credentials.

## Loading the environment

At the start of every run, `runOpenWikiAgent` calls `loadOpenWikiEnv` to load the home `.env` into the process environment, then syncs bundled skills. Provider and model selection are resolved afterward from the loaded environment and run options. The display path shown to users is `~/.openwiki` unless `OPENWIKI_CONFIG_DIR` is set, in which case the resolved absolute path is shown.

For how loaded credentials feed provider resolution and the run lifecycle, see [overview.md](overview.md).
