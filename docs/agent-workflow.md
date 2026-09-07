# From a coding task to shared repository memory

OpenWiki gives a coding agent a useful starting point in an unfamiliar repository
and a way to leave discoveries for the next agent. This walkthrough follows a
retry-budget investigation from maintained documentation through branch work,
shared reflections, and an update.

## Make the tools available

Install OpenWiki and choose your coding agent's integration:

```sh
npm install -g openwiki
openwiki integrations install claude
```

Replace `claude` with `codex`, `opencode`, or `cursor` for another supported host.
Restart the agent and open the repository. Installation defaults to user scope;
add `--project /work/acme` for a repository-scoped installation. After upgrading
OpenWiki, rerun installation to refresh the bundled skill and restart the agent.

If the repository has no wiki, ask the agent to initialize its OpenWiki from the
current source and tests. An existing wiki can be read immediately; retrieval
does not start generation or invoke an OpenWiki model. Older pages gain section
and prose links when they participate in an update.

Repository setup writes the same self-contained guidance into managed blocks in
`AGENTS.md` and `CLAUDE.md`, preserving surrounding user instructions. Each block
names the four memory tools and explains when they help. If MCP is unavailable,
`openwiki/quickstart.md` provides a file entry point.

## Find the explanation that matters

Suppose Acme runs background jobs and a task asks why the retry budget behaves
unexpectedly. The agent can start with:

```js
openwiki_orient({ root: "/work/acme" });
```

The response's maintained knowledge points to the relevant page:

```json
{
  "longTerm": {
    "overview": "Acme runs background jobs.",
    "pages": [
      {
        "page": "concepts/jobs.md",
        "title": "Jobs",
        "description": "Attempt limits and cancellation."
      },
      {
        "page": "quickstart.md",
        "title": "Quickstart",
        "description": "Repository purpose and navigation."
      }
    ]
  }
}
```

Retrieval responses below are excerpts; the [retrieval reference](retrieval.md)
shows complete shapes. The introduction comes from quickstart's opening prose,
and page titles and descriptions come from authored frontmatter.

Next, the agent inspects the page's sections:

```js
openwiki_outline({ root: "/work/acme", page: "concepts/jobs.md" });
```

Among the returned sections is:

```json
{
  "id": "section_retries",
  "location": "concepts/jobs.md#Jobs#Retries",
  "title": "Retries",
  "description": "Attempt limits."
}
```

The examples use readable placeholders for generated section, binding, and claim
IDs. Pass the actual returned section ID unchanged to read:

```js
openwiki_read({
  root: "/work/acme",
  page: "concepts/jobs.md",
  sections: ["section_retries"],
});
```

The selected explanation is connected to a claim and its evidence:

```json
{
  "longTerm": {
    "page": "concepts/jobs.md",
    "sections": [
      {
        "id": "section_retries",
        "location": "concepts/jobs.md#Jobs#Retries",
        "content": "## Retries\n\nJobs receive at most three attempts.\n\n"
      }
    ],
    "bindings": [
      {
        "id": "binding_attempts",
        "sectionId": "section_retries",
        "text": "Jobs receive at most three attempts.",
        "claimIds": ["claim_attempts"]
      }
    ],
    "claims": [
      {
        "id": "claim_attempts",
        "statement": "Jobs receive at most three attempts.",
        "evidence": [{ "resource": "repo://src/retry.ts" }]
      }
    ]
  }
}
```

An agent that already knows the page or section can read it directly. These tools
are independent; there is no required sequence or need to read the whole wiki.

## Account for main and local changes

The maintained explanation is long-term memory. It may still say three attempts
after main raises the limit to five. The same read flags the changed source in
short-term memory, connected to the claim that cites the file:

```json
{
  "shortTerm": {
    "changes": [
      {
        "resource": "repo://src/retry.ts",
        "inCheckout": false,
        "affectedClaimIds": ["claim_attempts"]
      }
    ],
    "reflections": []
  },
  "working": { "changes": [], "reflections": [] }
}
```

`inCheckout: false` means the main change is not fully incorporated into the
checkout's history. Retrieval
uses locally available Git history and does not fetch automatically.

As the task proceeds, the layers make these states distinguishable:

| Task state                   | Wiki explanation | Main change  | Checkout value | `inCheckout` | Working change |
| ---------------------------- | ---------------- | ------------ | -------------- | ------------ | -------------- |
| Branch is behind main        | Three attempts   | Three → five | Three          | `false`      | None           |
| Branch incorporates main     | Three attempts   | Three → five | Five           | `true`       | None           |
| Local edit raises the budget | Three attempts   | Three → five | Seven          | `true`       | Five → seven   |

The agent follows `repo://src/retry.ts`, checks the counter and loop boundary,
and verifies the behavior needed for the task. It inspects the relevant main
history when a change is not incorporated into its checkout. Native Git tools
can supply a diff when useful; retrieval returns the changed-resource references.
Main and working changes identify relevant evidence to inspect. They do not
rewrite the wiki or decide which
claims are false. Source and tests remain authoritative.

Orient connects changes to pages, outline connects them to sections, and read
connects them to claims. The agent gets the same memory layers at the level of
detail appropriate to each call.

## Leave a useful discovery

The investigation establishes a detail missing from the wiki: the configured
budget counts the initial call. The agent can record it after doing the work:

```js
openwiki_reflect({
  root: "/work/acme",
  finding:
    "The attempt limit includes the initial call: a budget of three permits at most two retries.",
  evidence: [{ resource: "repo://src/retry.ts" }],
});
```

The response identifies the new file:

```json
{
  "id": "reflection-550e8400-e29b-41d4-a716-446655440000",
  "path": "openwiki/.reflections/reflection-550e8400-e29b-41d4-a716-446655440000.json"
}
```

The fixture's retry source is a small loop; in a larger file, prefer bounded line
ranges and cite a relevant test as well. OpenWiki captures evidence versions so
an update can recheck the discovery. A reflection records reusable knowledge,
not simply that the task changed a constant. It remains provisional.

A second agent reading the retry section immediately sees the finding in
`working.reflections`, with its evidence and `relatedClaimIds`. Include the
returned file with the task's PR. Once the PR is merged and its files are present
in another checkout, that agent retrieves the same finding in
`shortTerm.reflections`, once. Merging shares the discovery; the wiki's long-term
explanation is unchanged until an update consolidates it.

## Consolidate during an update

Ask the coding agent to update OpenWiki for source changes and pending
reflections, or run the native `openwiki --update` workflow. Every reflection
present at the start receives a decision through the normal planning and page
authoring process.

In this example, the author verifies the current seven-attempt implementation
and revises the existing claim and bound prose to:

> Jobs receive at most seven attempts, including the initial call.

The claim and binding keep their IDs. The discovery now has a maintained home.
If two agents recorded the same finding, both can resolve to that one claim. An
unsupported finding such as “the retry loop allows unlimited attempts” is
discarded after checking the source.

Successful processing deletes those reflection files. There is no separate
outcome ledger or archive. A rejected page submission returns correction guidance
and leaves its pending discoveries available for retry. Completed page work is
preserved. Discoveries arriving during the run, such as a new cancellation
finding, wait for the next update.

The next retry read returns the maintained seven-attempt explanation and its
evidence. With the source checkpoint caught up, this section has no remaining
main changes, working changes, or pending reflections. The later cancellation
finding remains available in its own scope.

See [reflections](reflections.md) for the capture and consolidation contracts and
[page authoring](page-authoring.md) for sparse reconciliation and correction.

## Reproduce the workflow check

From the OpenWiki development checkout:

```sh
pnpm run build
pnpm exec vitest run test/integrations/memory-workflow.test.ts
```

The test installs the Claude integration into a temporary Git repository and
launches its configured MCP command against the built CLI. Two independent MCP
clients perform the retrieval and reflection calls. Local Git branches and a
fast-forward merge model sharing through a PR; no remote PR is created.

The check covers tool discovery, selected retrieval, main incorporation, later
working edits, shared reflections, consolidation of useful and duplicate
findings, unsupported findings, correction and retry, and later arrivals.
Authoring and evaluation decisions are scripted. This proves the integration and
memory lifecycle; it does not measure a live model's research quality, time
savings, or token savings.
