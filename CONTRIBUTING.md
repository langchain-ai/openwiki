# Contributing to OpenWiki

Thanks for contributing! Our standard for PR contributions is **one PR = one change**.
This allows us to keep reviews fast and the repo history clean.

## Scope: one PR = one change

Pull requests should be well scoped and every one should do exactly one thing.

Fixing a bug that's part of the change you're making is fine but if you find
yourself fixing something _unrelated_ along the way, open a separate PR for it.

### What "tightly scoped" means

✅ **Good:** "Add Fireworks to the model provider list" — the provider config,
its model options, and the doc line for it.

❌ **Too broad:** "Add a new provider, refactor the credential onboarding flow,
and fix a typo in the README" — three unrelated changes. You should split these
into three PRs.

## Before you open a PR

Run these locally so you don't get surprised by CI:

```sh
pnpm run format
pnpm run lint
pnpm test
```

`format` and `lint` match the checks that run on every PR, and `test` runs the
Vitest suite.

## PR expectations

- **Clear title** — a single sentence describing the one change, prefixed with a
  [Conventional Commits](https://www.conventionalcommits.org/) type such as
  `feat:`, `fix:`, or `chore:` (e.g. `feat: add Fireworks to the model provider list`).
- **What and why** — briefly explain what the PR does and the reason for it.
- **How you tested it** — describe the tests (unit or end-to-end) that verify your
  change works and doesn't break existing behavior. If you added or updated tests,
  note them here.
- **Link an issue** for anything non-trivial, so the change has context.

## A note for AI agents

If you are an agent opening a PR in this repository, these rules are binding.
Keep your change tightly scoped to a single concern. **If a change you're about
to make would violate anything in this document, stop and surface it to the
human instead of proceeding.**

## What gets closed

PRs that bundle multiple unrelated changes may be closed with a request to
split them into separate, tightly scoped PRs.
