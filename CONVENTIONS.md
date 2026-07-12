# Contributing to OpenWiki

How code here is meant to look and where it's meant to live. It's short; read it
before your first PR.

Rules are tagged like `[ow:interface-over-type]` so a review comment or a lint
error can point you straight back to the reason. If a rule turns out to be
wrong, change it in the PR that proves it wrong and say why.

## Where code lives

OpenWiki is a CLI that runs an LLM agent to document a repo (`code` mode) or your
own notes (`personal` mode). The agent loop itself is the `deepagents` package;
our code is the shell around it. `openwiki/quickstart.md` has the bigger picture.

Each concern owns a directory:

| Directory          | Owns                                                                                |
| ------------------ | ----------------------------------------------------------------------------------- |
| `src/cli/`         | Arg parsing, dispatch, the subcommand and `--print` handlers. Keep it thin.         |
| `src/ui/`          | Ink (terminal React) components. No domain logic.                                   |
| `src/providers/`   | Provider registry, provider/model resolution, `createModel`, model-provider OAuth.  |
| `src/config/`      | `~/.openwiki/.env` persistence, credential logic, the secret registry, redaction.   |
| `src/agent/`       | Run orchestration, the prompt, the write-scoping backend, stream parsing, metadata. |
| `src/connectors/`  | The data-source connectors and their OAuth.                                         |
| `src/constants.ts` | Literals only. No logic.                                                            |

`[ow:one-concern-per-dir]` New code goes where its concern already lives. If
nothing fits, that's a conversation, not a reason to drop it in the nearest file.

One trap worth naming: there are two unrelated OAuth systems. Model-provider
login (to the LLM, in `src/providers/`) and connector login (to Gmail, Slack, and
friends, in `src/connectors/`). They share only the `.env` store. A change to one
is never a change to the other, so don't review it as though it were.

## TypeScript

`[ow:interface-over-type]` Object shapes are `interface`. Keep `type` for the
things an interface can't express: unions, intersections, tuples, mapped types.

```ts
// no
type RunContext = { gitSummary: string; wikiGoal?: string };

// yes
interface RunContext {
  gitSummary: string;
  wikiGoal?: string;
}

// type still earns its keep:
type OpenWikiProvider = "anthropic" | "openai" | "openrouter";
```

`[ow:undefined-over-null]` Absent is `undefined`, not `null`. Don't add `| null`.
If you're already editing code that uses it, flip it rather than run both
conventions side by side.

`[ow:no-any]` No `any`. Use `unknown` at the boundary and narrow it. If you truly
need `any`, leave a comment explaining why.

`[ow:readonly-inputs]` Mark properties and array params `readonly` when nothing
is meant to mutate them.

## Docstrings

`[ow:docstring-exports]` Every export gets a docstring, and `[ow:docstring-fields]`
so does every field whose meaning isn't obvious from its name, optional ones
especially (say what happens when it's absent). Explain what the thing is for,
not what its name already says.

`[ow:docstring-style]` Always the block form, never a collapsed one-liner, with a
blank line between documented fields:

```ts
/**
 * A single labeled diagnostic line describing an error, for display or logs.
 */
export interface ErrorDiagnostic {
  /**
   * Short label naming the field (e.g. `status`, `header.cf-ray`).
   */
  readonly label: string;

  /**
   * The value, already redacted for display.
   */
  readonly value: string;
}
```

`[ow:comment-the-why]` Comments explain why, not what. If a line needs a comment
to say what it does, rewrite the line instead.

## Errors and secrets

`[ow:validate-early]` Check inputs where they enter and throw a plain `Error`.
Don't let a bad value travel deeper into the code.

`[ow:actionable-messages]` An error says what broke, the offending value where
it's safe to show, and how to fix it. No bare "failed", no apologies.

The rule that matters most here: forgetting something should fail safe, not leak.
Make the safe path the path you get for free.

`[ow:redact-user-output]` Anything that might carry a credential and reaches a
user or a log goes through `src/config/redaction.ts` first: error messages,
header dumps, provider response bodies.

`[ow:secret-registry]` Secrets are declared once, in the registry. Redaction and
diagnostics both derive their list from it, so registering a key in one place
makes it persisted, masked, and redacted everywhere. Never keep a second "these
are the secrets" list.

`[ow:secret-default-closed]` `[ow:no-fail-open]` A managed env key is secret
unless it's explicitly marked otherwise, so forgetting to classify one
over-redacts instead of leaking. Same idea everywhere: when correctness depends
on someone remembering to call a scrubber or pass a flag, restructure so the safe
thing happens by default.

## Structure and style

`[ow:no-god-files]` One file, one responsibility. Around 500 lines is where you
stop and split. The 3.8k-line `cli.tsx` is exactly what we're unwinding.

`[ow:ui-separate-from-logic]` Domain logic stays out of Ink components. If
something can only be tested by rendering a component, it's in the wrong place.

`[ow:constants-are-literals]` A constants file holds values. Resolution and
branching are logic and belong in a real module: `resolveConfiguredProvider`
lives in `src/providers/`, not `constants.ts`.

`[ow:kebab-files]` Filenames are kebab-case: `model-factory.ts`.

`[ow:style-is-automated]` Quotes, semicolons, import order, line length: Prettier
and ESLint own these, so run the formatter instead of arguing in review. (Lint
rules that enforce the conventions above are coming; until then they're review
conventions.)

## Testing

`[ow:test-the-boundary]` The security and correctness boundaries get tests for how
they fail, not just the happy path: redaction, the write-scoping backend,
provider/model resolution, env parsing.

## Adding a provider or a connector

**A provider.** First ask whether it speaks the OpenAI wire format. If it does,
it's already supported: point `OPENAI_COMPATIBLE_BASE_URL` at it and you're done,
no PR required. A first-class entry earns its place only with a curated model
list or a genuinely different wire format or auth. When one is warranted: add it
to the `OpenWikiProvider` union and the registry, add its key to the managed env
keys and mark it secret (redaction follows automatically), add a `createModel`
branch only if it isn't OpenAI-compatible, and test resolution.

**A connector.** Fetch raw data deterministically, let the agent synthesize it,
and keep those two steps apart. Connector auth is the connector OAuth system,
never the model-provider one. MCP-backed connectors are read-only.
