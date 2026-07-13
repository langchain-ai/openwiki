# Contributing to OpenWiki

This is a short guide to how the code here is written and where things live. You
should read this before contributing your first PR.

## Where code lives

OpenWiki is a CLI that runs a Deep Agent to document a repository (`code` mode)
or your own notes (`personal` mode).

Each directory owns one concern:

| Directory          | Owns                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/cli/`         | Argument parsing, dispatch, and the subcommand and `--print` handlers. Keep it thin.                                                 |
| `src/ui/`          | Ink (terminal React) components. No domain logic.                                                                                    |
| `src/agent/`       | Run orchestration, the prompt, the write-scoping backend, stream parsing, metadata, and model-provider OAuth (ChatGPT/Claude login). |
| `src/providers/`   | The model-provider registry, provider and model resolution, `createModel`, and the model-selection helpers.                          |
| `src/connectors/`  | The data-source connectors: their runtimes, the source catalog, and shared connector types.                                          |
| `src/auth/`        | Connector/source OAuth (Gmail, Notion, Slack, X): the OAuth flow, token storage, and the local callback tunnel.                      |
| `src/onboarding/`  | Onboarding config persistence (`store.ts`) and the setup wizard's tables and helpers (`setup.ts`).                                   |
| `src/schedules/`   | Cron parsing and validation, launchd connector schedules, and macOS pmset power windows.                                             |
| `src/config/`      | Credential and setup-step decisions: credential presence, the setup step machine, and path helpers.                                  |
| `src/constants.ts` | Literal values only. No logic.                                                                                                       |

Do your best to place new code where its concern already lives. If it doesn't fit
anywhere, that may mean a new directory, which is worth a conversation rather than
dropping it into the nearest file.

A few modules still live directly under `src/` rather than in a concern
directory. `index.tsx` (the CLI entry point) and `constants.ts` belong there.
The rest are foundational modules used across concerns: `env.ts` (reads and
writes `~/.openwiki/.env` and owns the secret registry), `diagnostics.ts`
(user-facing error messages and secret redaction), `openwiki-home.ts` (the
on-disk layout of the `~/.openwiki` home), plus `ingestion.ts`, `code-mode.ts`,
`startup.ts`, and small shared helpers (`fs-errors.ts`, `utils.ts`). These are
candidates to fold into `config/` and `connectors/` over time; until then, add
new code to the directories above rather than at the root.

## TypeScript

Use `interface` for object shapes. Reach for `type` only when an interface
can't express what you mean: unions, intersections, tuples, and mapped types.

```ts
// no
type RunContext = { gitSummary: string; wikiGoal?: string };

// yes
interface RunContext {
  gitSummary: string;
  wikiGoal?: string;
}

// type still earns its place here:
type OpenWikiProvider = "anthropic" | "openai" | "openrouter";
```

Absent values should be `undefined` instead of `null`. Don't introduce `| null`.
If you are already editing code that uses it, flip it rather than leave two
conventions running side by side.

No `any`, prefer to take `unknown` at the boundary and narrow it. On the rare
occasion you genuinely need `any` please leave a comment saying why.

Mark inputs `readonly` when nothing is meant to mutate them, both object
properties and array parameters.

## Docstrings

Every export gets a docstring, and so does every field of an interface, even the
ones that look obvious. For an optional field, say what happens when it is
absent, typically with `@default`. Explain what the thing is for instead of what
its name already tells you.

Use the block form with a blank line between documented fields, never a
collapsed one-liner:

```ts
/**
 * A single labeled diagnostic line describing an error, for display or logs.
 */
export interface ErrorDiagnostic {
  /**
   * Short label naming the field, e.g. `status` or `header.cf-ray`.
   */
  readonly label: string;

  /**
   * The value, already redacted for display.
   */
  readonly value: string;
}
```

Comments should explain why not what. In general, code should be self-documents but
it is okay if a line needs a comment to say what it does.

## Errors and secrets

Validate inputs where they enter and throw a plain `Error` on the spot. Don't
let a bad value travel deeper into the code before it fails.

An error message should say what broke, show the offending value where it is safe
to, and point at the fix. In general, error messages should be descriptive enough
that the consumer understands **why** something failed and **how** to fix it.

The rule that matters most here: forgetting something should fail safe, not leak.
Make the safe path the one you get for free. In practice that means:

- Anything that might carry a credential and reaches a user or a log goes through
  the redaction in `src/diagnostics.ts` first: error messages, header dumps, and
  provider response bodies.
- Secrets are declared once, in the registry. Redaction and diagnostics both
  derive their list from it, so registering a key in one place makes it
  persisted, masked, and redacted everywhere. Never keep a second "these are the
  secrets" list.
- A managed env key is treated as secret unless it is explicitly marked
  otherwise, so forgetting to classify one over-redacts instead of leaking.

## Structure and style

One file should represent one responsibility (separation of concerns).

Keep domain logic out of Ink components. If something can only be tested by
rendering a component it is probably in the wrong place. You should pull it
into a plain module and test it directly.

Filenames are kebab-case: `model-factory.ts`, not `modelFactory.ts` or
`model_factory.ts`.

## Testing

Test the boundaries for how they fail, not just the happy path. Redaction, the
write-scoping backend, provider and model resolution, and env parsing all deserve
tests that push on the failure modes.

In general, the test directory should match the structure of the src directory. Any
changes you're adding should come with associated unit tests. Updating an existing
unit test should make you question if what you're doing is a breaking change.
