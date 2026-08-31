## Purpose

Defines the IBM Bob inference provider — how OpenWiki authenticates, routes requests, and discovers models when `OPENWIKI_PROVIDER=bob` is configured. The User-Agent for all Bob inference requests is `ibm-bob-openwiki-provider` (confirmed by the Bob team as the OpenWiki-specific registered value).

## ADDED Requirements

### Requirement: Bob is a selectable provider

The system SHALL expose `"bob"` as a valid value for `OPENWIKI_PROVIDER`.

#### Scenario: Valid provider value accepted

- **WHEN** `OPENWIKI_PROVIDER=bob` is set in the environment
- **THEN** OpenWiki starts without a provider validation error

#### Scenario: Invalid provider value rejected

- **WHEN** `OPENWIKI_PROVIDER=bob-typo` or any unrecognized value is set
- **THEN** OpenWiki rejects it with the same error it uses for other invalid providers

---

### Requirement: Bob authenticates with an API key

The system SHALL authenticate Bob inference requests using the `BOB_API_KEY` environment variable.

The authorization header MUST use the scheme `Apikey` (not `Bearer`), formatted as `Authorization: Apikey <value>`.

#### Scenario: API key present — requests are authorized

- **WHEN** `BOB_API_KEY` is set to a valid key
- **THEN** outgoing inference requests carry `Authorization: Apikey <key>`

#### Scenario: API key absent — startup fails with a clear error

- **WHEN** `OPENWIKI_PROVIDER=bob` and `BOB_API_KEY` is not set
- **THEN** OpenWiki exits with an error naming `BOB_API_KEY` as the missing credential

---

### Requirement: Bob requests include a fixed User-Agent

The system SHALL set `User-Agent: ibm-bob-openwiki-provider` on all requests to the Bob inference endpoint.

#### Scenario: User-Agent is present on inference calls

- **WHEN** any request is sent to the Bob inference endpoint
- **THEN** the request carries `User-Agent: ibm-bob-openwiki-provider`

---

### Requirement: Bob uses a configurable base URL

The system SHALL use `https://api.us-east.bob.ibm.com/inference/v1` as the default base URL for the Bob provider.

The system SHALL allow `BOB_BASE_URL` to override the base URL.

#### Scenario: Default base URL used when override is absent

- **WHEN** `BOB_BASE_URL` is not set
- **THEN** requests go to `https://api.us-east.bob.ibm.com/inference/v1`

#### Scenario: Override base URL used when set

- **WHEN** `BOB_BASE_URL` is set to a valid HTTPS URL
- **THEN** requests go to that URL instead

---

### Requirement: Bob exposes a curated model list

The system SHALL offer the following model IDs as selectable defaults for the Bob provider:

- `premium` — Premium (Claude Sonnet 4.5), 200k context / 64k output
- `premium-shell` — Premium Shell (Claude Sonnet 4.6), 270k context / 64k output
- `fast` — Fast, 200k context / 64k output
- `ultra` — Ultra, 270k context / 128k output
- `explorer` — Explorer (Claude Haiku 4.5), 200k context / 64k output

#### Scenario: Model list shown in setup UI

- **WHEN** the user selects the Bob provider during credential setup
- **THEN** the model picker displays the curated model list

#### Scenario: Custom model ID accepted

- **WHEN** `OPENWIKI_MODEL_ID` is set to any non-empty string with the Bob provider
- **THEN** that model ID is used without validation against the curated list

---

### Requirement: Bob credential is stored and diagnosed

The system SHALL include `BOB_API_KEY` in the credential management flow (stored in `~/.openwiki/.env`, shown in diagnostics).

#### Scenario: Key persisted during setup

- **WHEN** the user completes Bob credential setup
- **THEN** `BOB_API_KEY` is written to `~/.openwiki/.env`

#### Scenario: Key shown in credential diagnostics

- **WHEN** the user runs credential diagnostics
- **THEN** `BOB_API_KEY` appears in the diagnostic output (value redacted)
