## Purpose

Defines how OpenWiki checks whether a configured model is available for a given provider before starting a run, including provider-specific bypass rules.

## ADDED Requirements

### Requirement: Bob provider bypasses the standard model availability check

The system SHALL skip the standard OpenAI-compatible `GET /v1/models` availability check when the active provider is `bob`.

The Bob inference endpoint exposes models at `GET /inference/v1/model/info` (a custom response shape), not at `/v1/models`. Querying the wrong endpoint returns an error that would incorrectly block a valid run.

#### Scenario: Run proceeds without a model-availability error for Bob

- **WHEN** `OPENWIKI_PROVIDER=bob` and a valid `BOB_API_KEY` and model ID are configured
- **THEN** OpenWiki starts the run without attempting a `GET /v1/models` call to the Bob endpoint
- **AND** no "model unavailable" error is surfaced based on that check

#### Scenario: Availability check still runs for other providers

- **WHEN** any provider other than `bob` is active
- **THEN** the standard availability check behavior is unchanged
