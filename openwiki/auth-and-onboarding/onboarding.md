---
type: Reference
title: First-Run Onboarding
description: How OpenWiki decides whether setup is needed and how the credentials wizard collects provider credentials and onboarding choices into the OpenWiki home.
tags: [onboarding, setup, credentials, wizard, configuration]
sources:
  - id: openwiki-source-c35800ddf00768a1fa848d13
    resource: repo://src/setup/credentials/persistence.ts
  - id: openwiki-source-7388b63c6f928737a7109779
    resource: repo://src/setup/credentials/steps.ts
  - id: openwiki-source-14d4f389b56575bb7afd1310
    resource: repo://src/setup/onboarding.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-22T08:02:55.052Z" }
verified:
  - by: openwiki/0.3.3
    at: 2026-08-22T08:02:55.052Z
---

# First-Run Onboarding

On first use OpenWiki runs an interactive wizard that collects the model-provider credential and the user's wiki/source choices, persisting them so later runs start immediately.

## Persisted state

Onboarding state is a versioned `onboarding.json` under the OpenWiki home, alongside a separate `INSTRUCTIONS.md` that supplies the wiki goal. The config records the selected mode/template, source instances and their per-source config, schedules, power-management settings, and a completion timestamp.

## The setup gate

`needsCredentialSetup` gates the wizard on **both** credentials and onboarding completion. It requires setup when the provider is invalid or missing any required credential, base URL, region, secret key, model, or LangSmith step, and otherwise when onboarding for the current mode is incomplete.

Whether the primary credential is still needed depends on the provider type:

| Provider type                    | Credential considered present when…               |
| -------------------------------- | ------------------------------------------------- |
| OAuth                            | a valid, non-expired stored token exists          |
| API-key                          | a key has been pasted                             |
| Keyless (e.g. gemini-enterprise) | required config such as the GCP project id is set |

## Collecting and persisting

The wizard collects values, but the caller owns persistence: `saveOpenWikiEnv` writes the resulting env and owns the file permissions.

`buildCredentialEnvUpdates` is a **pure** function that computes the `~/.openwiki/.env` update map from the collected wizard values, doing no IO. It includes a key only when a value was collected and writes the provider key only when it actually changes, so a re-run that keeps the same provider does not churn the file.

For the credential storage location and home layout, see [architecture/configuration.md](../architecture/configuration.md). For the OAuth flows themselves, see [auth.md](auth.md).
