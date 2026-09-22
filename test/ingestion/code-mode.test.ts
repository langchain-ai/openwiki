import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parse } from "yaml";
import {
  ensureCodeModeRepoSetup,
  runCodeModeConnectors,
} from "../../src/ingestion/code-mode.ts";
import type { OpenWikiRunEvent } from "../../src/agent/types.ts";

const SNIPPET_START = "<!-- OPENWIKI:START -->";
const SNIPPET_END = "<!-- OPENWIKI:END -->";

// The bare `## OpenWiki` section a pre-marker (0.0.x) release wrote directly
// into AGENTS.md / CLAUDE.md, before the managed markers existed.
const LEGACY_SENTENCE =
  "This repository has documentation located in the /openwiki directory.";
const LEGACY_SECTION = `## OpenWiki

${LEGACY_SENTENCE}

Start here:

- [OpenWiki quickstart](openwiki/quickstart.md)

OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

When working in this repository, read the OpenWiki quickstart first, then follow its links to the relevant architecture, workflow, domain, operation, and testing notes.`;

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const tempRepos: string[] = [];

interface WorkflowStep {
  name?: string;
  id?: string;
  "continue-on-error"?: boolean;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

async function createTempRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-code-mode-"));
  tempRepos.push(repo);
  return repo;
}

async function readIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseWorkflowSteps(workflow: string): WorkflowStep[] {
  const document = parse(workflow) as {
    jobs?: { update?: { steps?: unknown } };
  };
  const steps = document.jobs?.update?.steps;
  if (!Array.isArray(steps)) {
    throw new Error("Expected the OpenWiki workflow to define update steps.");
  }
  return steps as WorkflowStep[];
}

function requireWorkflowStep(
  steps: readonly WorkflowStep[],
  name: string,
): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`Expected the OpenWiki workflow to define ${name}.`);
  }
  return step;
}

function expectFailurePreservingWorkflow(workflow: string): void {
  const steps = parseWorkflowSteps(workflow);
  const run = requireWorkflowStep(steps, "Run OpenWiki");
  const cleanup = requireWorkflowStep(
    steps,
    "Remove transient OpenWiki run state",
  );
  const pullRequest = requireWorkflowStep(
    steps,
    "Create OpenWiki update pull request",
  );
  const annotation = requireWorkflowStep(
    steps,
    "Annotate OpenWiki update pull request",
  );
  const propagate = requireWorkflowStep(steps, "Propagate OpenWiki failure");

  expect(run.id).toBe("openwiki");
  expect(run["continue-on-error"]).toBe(true);
  expect(cleanup.if).toBe("${{ !cancelled() }}");
  expect(cleanup.run).toBe("rm -f -- openwiki/.run.json");
  expect(pullRequest.id).toBe("create-pr");
  expect(pullRequest.if).toBe("${{ !cancelled() }}");
  expect(pullRequest.uses).toMatch(
    /^peter-evans\/create-pull-request@[a-f0-9]{40}$/u,
  );
  expect(pullRequest.with?.branch).toBe("openwiki/update");
  expect(pullRequest.with?.["commit-message"]).toBe("docs: update OpenWiki");
  expect(pullRequest.with?.title).toBe("docs: update OpenWiki");
  expect(pullRequest.with?.["add-paths"]).toBe(
    "openwiki\nAGENTS.md\nCLAUDE.md\n.github/workflows/openwiki-update.yml\n",
  );
  expect(pullRequest.with?.body).toContain(
    "OpenWiki result: ${{ steps.openwiki.outcome }}",
  );
  expect(pullRequest.with?.body).toContain(
    "pages completed before the failure",
  );
  expect(pullRequest.with?.body).toContain(
    "baseline for the next scheduled run",
  );
  expect(annotation.if).toBe(
    "${{ !cancelled() && steps.create-pr.outputs.pull-request-url != '' }}",
  );
  expect(annotation.run).toBe(
    'echo "::notice title=OpenWiki update pull request::${{ steps.create-pr.outputs.pull-request-url }}"',
  );
  expect(propagate.if).toBe("${{ steps.openwiki.outcome == 'failure' }}");
  expect(propagate.run).toBe("exit 1");

  expect(steps.indexOf(run)).toBeLessThan(steps.indexOf(cleanup));
  expect(steps.indexOf(cleanup)).toBeLessThan(steps.indexOf(pullRequest));
  expect(steps.indexOf(pullRequest)).toBeLessThan(steps.indexOf(annotation));
  expect(steps.indexOf(annotation)).toBeLessThan(steps.indexOf(propagate));
  expect(
    steps
      .map((step) => step.run)
      .filter((command): command is string => command !== undefined)
      .join("\n"),
  ).not.toContain("openwiki/update");
}

afterEach(async () => {
  await Promise.all(
    tempRepos
      .splice(0)
      .map((repo) => rm(repo, { force: true, recursive: true })),
  );
});

describe("ensureCodeModeRepoSetup agent files", () => {
  test("creates both AGENTS.md and CLAUDE.md when neither exists", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo);

    for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
      const content = await readIfPresent(path.join(repo, fileName));
      expect(content, `${fileName} should be created`).not.toBeNull();
      expect(content).toContain(SNIPPET_START);
      expect(content).toContain(SNIPPET_END);
      expect(content).toContain("## OpenWiki");
    }
  });

  test("prefers progressive retrieval tools and keeps quickstart as fallback", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo);

    const agentsContent = await readIfPresent(path.join(repo, "AGENTS.md"));
    expect(agentsContent).toContain(
      "Do not enumerate, preload, or search wikis at task start",
    );
    expect(agentsContent).toContain("Stop once the question is grounded");
    expect(agentsContent).toContain(
      "When those conditions apply and OpenWiki retrieval tools are available",
    );
    expect(agentsContent).toContain("use `openwiki_search`");
    expect(agentsContent).toContain("`openwiki_read`");
    expect(agentsContent).toContain("`workspace_required`");
    expect(agentsContent).toContain("retrieval tools are unavailable");
    expect(agentsContent).toContain("`openwiki/quickstart.md`");
  });

  test("CLAUDE.md is a simple reference to AGENTS.md, not a copy of its full content", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo);

    const claudeContent = await readIfPresent(path.join(repo, "CLAUDE.md"));
    const agentsContent = await readIfPresent(path.join(repo, "AGENTS.md"));

    expect(claudeContent).not.toBeNull();
    expect(agentsContent).not.toBeNull();

    // CLAUDE.md should reference AGENTS.md rather than duplicate its instructions.
    expect(claudeContent).toContain("AGENTS.md");
    // The reference has to be Claude Code's `@path` import. A Markdown link is
    // inert text to its loader, and it does not read AGENTS.md on its own once
    // a CLAUDE.md exists, so a link would leave the block unreachable.
    expect(claudeContent).toContain("@AGENTS.md");
    expect(claudeContent).not.toContain("[AGENTS.md](AGENTS.md)");
    // CLAUDE.md should be shorter than AGENTS.md because it is a pointer, not a copy.
    expect((claudeContent ?? "").length).toBeLessThan(
      (agentsContent ?? "").length,
    );
  });

  test("inlines the instructions when CLAUDE.md is a link to AGENTS.md", async () => {
    const repo = await createTempRepo();
    await writeFile(path.join(repo, "AGENTS.md"), "", "utf8");
    await symlink("AGENTS.md", path.join(repo, "CLAUDE.md"));

    await ensureCodeModeRepoSetup(repo);

    const content = await readIfPresent(path.join(repo, "CLAUDE.md"));
    // Importing AGENTS.md here would point the file at itself.
    expect(content).not.toContain("@AGENTS.md");
    expect(content).toContain("generated `openwiki/` evidence index");
  });

  test("preserves CLAUDE.md when it only imports AGENTS.md", async () => {
    const repo = await createTempRepo();
    const existing = "  @AGENTS.md\n";
    await writeFile(path.join(repo, "CLAUDE.md"), existing, "utf8");

    await ensureCodeModeRepoSetup(repo);

    expect(await readIfPresent(path.join(repo, "CLAUDE.md"))).toBe(existing);
  });

  test("refreshes the OpenWiki block in place and preserves surrounding content", async () => {
    const repo = await createTempRepo();
    const existing = `# My Project

Hand-written guidance for coding agents.

${SNIPPET_START}
stale OpenWiki content
${SNIPPET_END}

Trailing notes that must survive.
`;
    await writeFile(path.join(repo, "CLAUDE.md"), existing, "utf8");

    await ensureCodeModeRepoSetup(repo);

    const content = await readIfPresent(path.join(repo, "CLAUDE.md"));
    expect(content).toContain("# My Project");
    expect(content).toContain("Hand-written guidance for coding agents.");
    expect(content).toContain("Trailing notes that must survive.");
    expect(content).not.toContain("stale OpenWiki content");
    // Exactly one managed block after a refresh.
    expect(content?.match(new RegExp(SNIPPET_START, "g"))).toHaveLength(1);
  });

  test("appends the block to an existing file without markers, keeping content", async () => {
    const repo = await createTempRepo();
    const existing = "# Existing AGENTS\n\nDo not lose this line.\n";
    await writeFile(path.join(repo, "AGENTS.md"), existing, "utf8");

    await ensureCodeModeRepoSetup(repo);

    const content = await readIfPresent(path.join(repo, "AGENTS.md"));
    expect(content).toContain("Do not lose this line.");
    expect(content).toContain(SNIPPET_START);
    // Appended after the original content, not prepended over it.
    expect(content?.indexOf("Do not lose this line.")).toBeLessThan(
      content?.indexOf(SNIPPET_START) ?? -1,
    );
  });

  test("is idempotent across repeated runs", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo);
    const first = await readIfPresent(path.join(repo, "CLAUDE.md"));
    await ensureCodeModeRepoSetup(repo);
    const second = await readIfPresent(path.join(repo, "CLAUDE.md"));

    expect(second).toEqual(first);
  });

  test("replaces a legacy unmarked OpenWiki section in place and stays idempotent", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "AGENTS.md"),
      `${LEGACY_SECTION}\n`,
      "utf8",
    );

    await ensureCodeModeRepoSetup(repo);
    const first = await readIfPresent(path.join(repo, "AGENTS.md"));

    expect(first).toContain(SNIPPET_START);
    expect(first).toContain(SNIPPET_END);
    // The old section is gone, so only the managed block's heading remains.
    expect(first).not.toContain(LEGACY_SENTENCE);
    expect(countOccurrences(first ?? "", "## OpenWiki")).toBe(1);

    await ensureCodeModeRepoSetup(repo);
    const second = await readIfPresent(path.join(repo, "AGENTS.md"));
    expect(second).toBe(first);
  });

  for (const [name, trailing, marker] of [
    [
      "a ### subsection",
      "### My notes\n\nKeep this subsection.\n",
      "Keep this subsection.",
    ],
    [
      "a plain paragraph",
      "Keep this hand-written paragraph.\n",
      "Keep this hand-written paragraph.",
    ],
    [
      "a setext heading",
      "My Notes\n--------\n\nKeep this setext body.\n",
      "Keep this setext body.",
    ],
    [
      "an Nx-style comment block",
      "<!-- nx configuration -->\n\nKeep this tool block.\n",
      "Keep this tool block.",
    ],
  ] as const) {
    test(`preserves ${name} written below a legacy section`, async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "AGENTS.md"),
        `${LEGACY_SECTION}\n\n${trailing}`,
        "utf8",
      );

      await ensureCodeModeRepoSetup(repo);
      const content = await readIfPresent(path.join(repo, "AGENTS.md"));

      // The template lines go; the user's content underneath does not.
      expect(content).not.toContain(LEGACY_SENTENCE);
      expect(content).toContain(marker);
      expect(content).toContain(SNIPPET_START);
      // The block lands where the section was, above the preserved content.
      expect(content?.indexOf(SNIPPET_START)).toBeLessThan(
        content?.indexOf(marker) ?? -1,
      );
    });
  }

  test("replaces a legacy section that sits at the end of the file", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "AGENTS.md"),
      `# My Project\n\nSome intro that must survive.\n\n${LEGACY_SECTION}\n`,
      "utf8",
    );

    await ensureCodeModeRepoSetup(repo);
    const content = await readIfPresent(path.join(repo, "AGENTS.md"));

    expect(content).toContain("Some intro that must survive.");
    expect(content).not.toContain(LEGACY_SENTENCE);
    expect(content).toContain(SNIPPET_START);
    expect(content?.indexOf("Some intro that must survive.")).toBeLessThan(
      content?.indexOf(SNIPPET_START) ?? -1,
    );
  });

  test("handles a legacy section written with CRLF line endings", async () => {
    const repo = await createTempRepo();
    const crlf = `${LEGACY_SECTION}\n\nKeep this CRLF line.\n`.replace(
      /\n/gu,
      "\r\n",
    );
    await writeFile(path.join(repo, "AGENTS.md"), crlf, "utf8");

    await ensureCodeModeRepoSetup(repo);
    const content = await readIfPresent(path.join(repo, "AGENTS.md"));

    expect(content).not.toContain(LEGACY_SENTENCE);
    expect(content).toContain("Keep this CRLF line.");
    expect(content).toContain(SNIPPET_START);
    expect(countOccurrences(content ?? "", "## OpenWiki")).toBe(1);
  });

  test("removes every legacy section when a file has more than one", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "AGENTS.md"),
      `${LEGACY_SECTION}\n\n${LEGACY_SECTION}\n\nKeep this trailer.\n`,
      "utf8",
    );

    await ensureCodeModeRepoSetup(repo);
    const content = await readIfPresent(path.join(repo, "AGENTS.md"));

    expect(content).not.toContain(LEGACY_SENTENCE);
    expect(content).toContain("Keep this trailer.");
    // Both old sections collapse into the single managed block.
    expect(countOccurrences(content ?? "", "## OpenWiki")).toBe(1);
    expect(countOccurrences(content ?? "", SNIPPET_START)).toBe(1);
  });

  test("removes a legacy section that sits beside an existing managed block", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "AGENTS.md"),
      `${LEGACY_SECTION}\n\n${SNIPPET_START}\nstale managed block\n${SNIPPET_END}\n`,
      "utf8",
    );

    await ensureCodeModeRepoSetup(repo);
    const content = await readIfPresent(path.join(repo, "AGENTS.md"));

    expect(content).not.toContain(LEGACY_SENTENCE);
    expect(content).not.toContain("stale managed block");
    expect(countOccurrences(content ?? "", SNIPPET_START)).toBe(1);
    expect(countOccurrences(content ?? "", "## OpenWiki")).toBe(1);
  });

  test("reduces an @AGENTS.md CLAUDE.md with a legacy section to just the import", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "CLAUDE.md"),
      `@AGENTS.md\n\n${LEGACY_SECTION}\n`,
      "utf8",
    );

    await ensureCodeModeRepoSetup(repo);

    // AGENTS.md carries the managed block, so CLAUDE.md is left as the import.
    expect(await readIfPresent(path.join(repo, "CLAUDE.md"))).toBe(
      "@AGENTS.md\n",
    );
  });

  test("leaves a fenced quote of the old snippet untouched", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "AGENTS.md"),
      `# Docs\n\nExample of the old snippet:\n\n\`\`\`markdown\n${LEGACY_SECTION}\n\`\`\`\n`,
      "utf8",
    );

    await ensureCodeModeRepoSetup(repo);
    const content = await readIfPresent(path.join(repo, "AGENTS.md"));

    // A heading inside a code fence is not a real section, so it survives and
    // the block is simply appended after it.
    expect(content).toContain(LEGACY_SENTENCE);
    expect(content).toContain("```markdown");
    expect(content).toContain(SNIPPET_START);
    expect(content?.indexOf("```markdown")).toBeLessThan(
      content?.indexOf(SNIPPET_START) ?? -1,
    );
  });

  test("leaves a hand-written OpenWiki section without the template sentence", async () => {
    const repo = await createTempRepo();
    const handWritten =
      "## OpenWiki\n\nOur own notes about the OpenWiki feature, unrelated to the generated wiki.\n";
    await writeFile(path.join(repo, "AGENTS.md"), handWritten, "utf8");

    await ensureCodeModeRepoSetup(repo);
    const content = await readIfPresent(path.join(repo, "AGENTS.md"));

    // No template sentence means it is not ours to remove.
    expect(content).toContain(
      "Our own notes about the OpenWiki feature, unrelated to the generated wiki.",
    );
    expect(content).toContain(SNIPPET_START);
  });

  test("leaves an indented legacy snippet shown as a Markdown code block", async () => {
    const repo = await createTempRepo();
    const indented = LEGACY_SECTION.replace(/^/gmu, "    ");
    await writeFile(path.join(repo, "AGENTS.md"), `${indented}\n`, "utf8");

    await ensureCodeModeRepoSetup(repo);
    const content = await readIfPresent(path.join(repo, "AGENTS.md"));

    expect(content).toContain(`    ${LEGACY_SENTENCE}`);
    expect(content).toContain(SNIPPET_START);
  });

  test("stops at a customized quickstart link", async () => {
    const repo = await createTempRepo();
    const customized = LEGACY_SECTION.replace(
      "- [OpenWiki quickstart](openwiki/quickstart.md)",
      "- [Team OpenWiki guide](openwiki/quickstart.md)",
    );
    await writeFile(path.join(repo, "AGENTS.md"), `${customized}\n`, "utf8");

    await ensureCodeModeRepoSetup(repo);
    const content = await readIfPresent(path.join(repo, "AGENTS.md"));

    expect(content).toContain(
      "- [Team OpenWiki guide](openwiki/quickstart.md)",
    );
    expect(content).toContain(SNIPPET_START);
  });

  test("stops at a template line the user appended text to, keeping it and everything below", async () => {
    const repo = await createTempRepo();
    // The "When working…" line is edited, so it is no longer a template line and
    // must halt the removal instead of being deleted with the user's addition.
    const edited = `## OpenWiki

${LEGACY_SENTENCE}

Start here:

- [OpenWiki quickstart](openwiki/quickstart.md)

OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

When working in this repository, and ALSO CHECK OUR INTERNAL WIKI at https://wiki.example.com.

More hand-written notes below.
`;
    await writeFile(path.join(repo, "AGENTS.md"), edited, "utf8");

    await ensureCodeModeRepoSetup(repo);
    const content = await readIfPresent(path.join(repo, "AGENTS.md"));

    // The pristine template lines are gone, but the edited line and the notes
    // under it survive in full.
    expect(content).not.toContain(LEGACY_SENTENCE);
    expect(content).toContain(
      "When working in this repository, and ALSO CHECK OUR INTERNAL WIKI at https://wiki.example.com.",
    );
    expect(content).toContain("More hand-written notes below.");
    expect(content).toContain(SNIPPET_START);
  });

  test("leaves a snippet quoted in a ``` fence that itself contains a ~~~ line", async () => {
    const repo = await createTempRepo();
    // The nested `~~~` must not close the outer ``` fence, or the quoted heading
    // and sentence would be mistaken for a real section and removed.
    const existing = `# Docs

The old snippet, shown with a tilde block inside it:

\`\`\`md
~~~
## OpenWiki

${LEGACY_SENTENCE}

Start here:

- [OpenWiki quickstart](openwiki/quickstart.md)
~~~
\`\`\`
`;
    await writeFile(path.join(repo, "AGENTS.md"), existing, "utf8");

    await ensureCodeModeRepoSetup(repo);
    const content = await readIfPresent(path.join(repo, "AGENTS.md"));

    // Everything inside the fence survives; the block is merely appended after.
    expect(content).toContain(LEGACY_SENTENCE);
    expect(content).toContain("~~~");
    expect(content).toContain(SNIPPET_START);
    expect(content?.indexOf("~~~")).toBeLessThan(
      content?.indexOf(SNIPPET_START) ?? -1,
    );
  });

  test("reducing an @AGENTS.md CLAUDE.md with a legacy section is idempotent", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "CLAUDE.md"),
      `@AGENTS.md\n\n${LEGACY_SECTION}\n`,
      "utf8",
    );

    await ensureCodeModeRepoSetup(repo);
    const first = await readIfPresent(path.join(repo, "CLAUDE.md"));
    await ensureCodeModeRepoSetup(repo);
    const second = await readIfPresent(path.join(repo, "CLAUDE.md"));

    expect(first).toBe("@AGENTS.md\n");
    // The second run sees a bare import and leaves it byte-for-byte alone.
    expect(second).toBe(first);
  });

  test("removes a legacy section that follows an existing managed block", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "AGENTS.md"),
      `${SNIPPET_START}\nstale managed block\n${SNIPPET_END}\n\n${LEGACY_SECTION}\n`,
      "utf8",
    );

    await ensureCodeModeRepoSetup(repo);
    const content = await readIfPresent(path.join(repo, "AGENTS.md"));

    expect(content).not.toContain(LEGACY_SENTENCE);
    expect(content).not.toContain("stale managed block");
    expect(countOccurrences(content ?? "", SNIPPET_START)).toBe(1);
    expect(countOccurrences(content ?? "", "## OpenWiki")).toBe(1);
  });

  for (const [name, existing] of [
    [
      "an orphaned start marker",
      `# Project instructions

${SNIPPET_START}
DO NOT DELETE: hand-written project policy
`,
    ],
    [
      "an orphaned end marker",
      `# Project instructions

DO NOT DELETE: hand-written project policy
${SNIPPET_END}
`,
    ],
    [
      "reversed markers",
      `# Project instructions

${SNIPPET_END}
DO NOT DELETE: hand-written project policy
${SNIPPET_START}
`,
    ],
    [
      "duplicate managed blocks",
      `# Project instructions

${SNIPPET_START}
first managed block
${SNIPPET_END}

DO NOT DELETE: hand-written project policy

${SNIPPET_START}
second managed block
${SNIPPET_END}
`,
    ],
  ] as const) {
    test(`rejects ${name} without changing either agent file`, async () => {
      const repo = await createTempRepo();
      const agentsPath = path.join(repo, "AGENTS.md");
      await writeFile(agentsPath, existing, "utf8");

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(ensureCodeModeRepoSetup(repo)).rejects.toThrow(
          /AGENTS\.md.*managed markers are malformed or duplicated/u,
        );
      }

      expect(await readIfPresent(agentsPath)).toBe(existing);
      // Both files are prepared before either is written, so a malformed
      // AGENTS.md cannot leave a newly-created CLAUDE.md behind.
      expect(await readIfPresent(path.join(repo, "CLAUDE.md"))).toBeNull();
    });
  }
});

describe("ensureCodeModeRepoSetup workflow", () => {
  test("generated PR includes agent files and the workflow in add-paths", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo, { createWorkflow: true });

    const workflow = await readIfPresent(
      path.join(repo, ".github", "workflows", "openwiki-update.yml"),
    );
    expect(workflow).not.toBeNull();
    expect(workflow).toContain("add-paths: |");
    for (const managedPath of [
      "openwiki",
      "AGENTS.md",
      "CLAUDE.md",
      ".github/workflows/openwiki-update.yml",
    ]) {
      expect(workflow).toContain(managedPath);
    }
  });

  test("publishes completed pages before propagating an OpenWiki failure", async () => {
    const repo = await createTempRepo();
    await ensureCodeModeRepoSetup(repo, { createWorkflow: true });
    const generated = await readIfPresent(
      path.join(repo, ".github", "workflows", "openwiki-update.yml"),
    );
    if (generated === null) {
      throw new Error("expected the generated workflow to exist");
    }

    const repoRoot = path.resolve(import.meta.dirname, "..", "..");
    const [example, dogfood] = await Promise.all([
      readFile(path.join(repoRoot, "examples", "openwiki-update.yml"), "utf8"),
      readFile(
        path.join(repoRoot, ".github", "workflows", "openwiki-update.yml"),
        "utf8",
      ),
    ]);

    for (const workflow of [generated, example, dogfood]) {
      expectFailurePreservingWorkflow(workflow);
    }

    const dogfoodSteps = parseWorkflowSteps(dogfood);
    const run = requireWorkflowStep(dogfoodSteps, "Run OpenWiki");
    const restore = requireWorkflowStep(
      dogfoodSteps,
      "Restore protected workflow file",
    );
    const cleanup = requireWorkflowStep(
      dogfoodSteps,
      "Remove transient OpenWiki run state",
    );
    expect(restore.if).toBe("${{ !cancelled() }}");
    expect(dogfoodSteps.indexOf(run)).toBeLessThan(
      dogfoodSteps.indexOf(restore),
    );
    expect(dogfoodSteps.indexOf(restore)).toBeLessThan(
      dogfoodSteps.indexOf(cleanup),
    );
  });

  test("wires the LangSmith connector read key into the workflow env", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo, { createWorkflow: true });

    const workflow = await readIfPresent(
      path.join(repo, ".github", "workflows", "openwiki-update.yml"),
    );
    // Without this, the scheduled code-mode pull has no connector key in CI and
    // the LangSmith pull skips every run (the key is the connector's requiredEnv).
    expect(workflow).toContain(
      "OPENWIKI_LANGSMITH_API_KEY: ${{ secrets.OPENWIKI_LANGSMITH_API_KEY }}",
    );
  });

  test("pins the openwiki install to a specific version, never unpinned", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo, { createWorkflow: true });

    const workflow = await readIfPresent(
      path.join(repo, ".github", "workflows", "openwiki-update.yml"),
    );
    // Installing an unpinned package in a privileged CI context is a supply-chain
    // risk; the generated workflow must pin openwiki to the shipping version.
    expect(workflow).toMatch(/npm install --global openwiki@\d+\.\d+\.\d+ /u);
    expect(workflow).not.toMatch(/--global openwiki(?![@\d])/u);
  });

  test("does not create a workflow unless explicitly requested", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo);

    expect(
      await readIfPresent(
        path.join(repo, ".github", "workflows", "openwiki-update.yml"),
      ),
    ).toBeNull();
  });

  test("preserves a customized workflow when setup runs again", async () => {
    const repo = await createTempRepo();
    const workflowPath = path.join(
      repo,
      ".github",
      "workflows",
      "openwiki-update.yml",
    );
    const customizedWorkflow = `name: Custom OpenWiki Update

on:
  workflow_dispatch:

jobs:
  update:
    uses: ./.github/workflows/reusable-openwiki.yml
    with:
      model: gpt-5.6-terra
`;

    await ensureCodeModeRepoSetup(repo, { createWorkflow: true });
    await writeFile(workflowPath, customizedWorkflow, "utf8");
    await ensureCodeModeRepoSetup(repo, { createWorkflow: true });

    expect(await readIfPresent(workflowPath)).toBe(customizedWorkflow);
  });
});

describe("ensureCodeModeRepoSetup workflow provider block", () => {
  async function generateWorkflow(env: NodeJS.ProcessEnv): Promise<string> {
    const repo = await createTempRepo();
    await ensureCodeModeRepoSetup(repo, { createWorkflow: true, env });
    const workflow = await readIfPresent(
      path.join(repo, ".github", "workflows", "openwiki-update.yml"),
    );
    if (workflow === null) {
      throw new Error("expected the workflow to be created");
    }
    return workflow;
  }

  test("authenticates the provider the operator configured", async () => {
    const workflow = await generateWorkflow({
      OPENWIKI_PROVIDER: "copilot",
      OPENWIKI_MODEL_ID: "gpt-5.6-terra",
    });

    // A fixed provider block ships every non-default setup a workflow whose
    // first scheduled run fails on a secret the repo was never told about.
    expect(workflow).toContain("OPENWIKI_PROVIDER: copilot");
    expect(workflow).toContain(
      "COPILOT_API_KEY: ${{ secrets.COPILOT_API_KEY }}",
    );
    expect(workflow).toContain('OPENWIKI_MODEL_ID: "gpt-5.6-terra"');
    expect(workflow).not.toContain("OPENROUTER_API_KEY");
  });

  test("emits non-secret provider settings as repository variables", async () => {
    const workflow = await generateWorkflow({
      OPENWIKI_PROVIDER: "openai-compatible",
    });

    // The gateway endpoint is required but is configuration, not a credential.
    expect(workflow).toContain(
      "OPENAI_COMPATIBLE_BASE_URL: ${{ vars.OPENAI_COMPATIBLE_BASE_URL }}",
    );
    expect(workflow).toContain(
      "OPENAI_COMPATIBLE_API_KEY: ${{ secrets.OPENAI_COMPATIBLE_API_KEY }}",
    );
  });

  test("carries the streaming opt-in into the scheduled run", async () => {
    // A gateway that only serves SSE would otherwise return empty content in
    // CI and commit a blank wiki, with the local run still looking healthy.
    const optedIn = await generateWorkflow({
      OPENWIKI_PROVIDER: "openai-compatible",
      OPENWIKI_OPENAI_COMPATIBLE_STREAMING: "true",
    });

    expect(optedIn).toContain('OPENWIKI_OPENAI_COMPATIBLE_STREAMING: "true"');

    const notOptedIn = await generateWorkflow({
      OPENWIKI_PROVIDER: "openai-compatible",
    });

    expect(notOptedIn).not.toContain("OPENWIKI_OPENAI_COMPATIBLE_STREAMING");
  });

  test("pairs both AWS credentials and the region for Bedrock", async () => {
    const workflow = await generateWorkflow({ OPENWIKI_PROVIDER: "bedrock" });

    expect(workflow).toContain(
      "BEDROCK_AWS_SECRET_ACCESS_KEY: ${{ secrets.BEDROCK_AWS_SECRET_ACCESS_KEY }}",
    );
    expect(workflow).toContain(
      "BEDROCK_AWS_REGION: ${{ vars.BEDROCK_AWS_REGION }}",
    );
    // Bedrock model availability is account- and region-specific, so there is
    // no preset to suggest and a guessed ID would fail at runtime.
    expect(workflow).not.toContain("OPENWIKI_MODEL_ID");
  });

  test("does not pin a rotating browser-login token as a secret", async () => {
    const workflow = await generateWorkflow({
      OPENWIKI_PROVIDER: "openai-chatgpt",
    });

    expect(workflow).toContain("OPENWIKI_PROVIDER: openai-chatgpt");
    // The stored access token is refreshed in place, so a repo secret holding
    // it breaks on the first rotation rather than authenticating the run.
    expect(workflow).not.toContain("secrets.OPENAI_CHATGPT_ACCESS_TOKEN");
    expect(workflow).toContain("browser login");
  });

  test("quotes the model ID so reserved YAML characters survive", async () => {
    const workflow = await generateWorkflow({
      OPENWIKI_PROVIDER: "openai-compatible",
      OPENWIKI_MODEL_ID: "@cf/meta/llama-3.1-8b-instruct",
    });

    // A leading "@" is a reserved YAML indicator: unquoted, the workflow fails
    // to parse and the scheduled run never starts.
    expect(workflow).toContain(
      'OPENWIKI_MODEL_ID: "@cf/meta/llama-3.1-8b-instruct"',
    );
  });
});

describe("runCodeModeConnectors", () => {
  // The only code-mode connector is LangSmith, which reads committed repo config
  // and cleanly skips (no network) when a repo has not configured it. That lets
  // us exercise the loop, the fail-open skip, and the "nothing to append" merge
  // without reaching a real API. Making a connector succeed needs live creds and
  // is left to integration tests.

  test("returns the base message unchanged when no connector contributes", async () => {
    const repo = await createTempRepo();
    const base = "Base agent instructions.";

    const result = await runCodeModeConnectors(repo, base);

    expect(result).toBe(base);
  });

  test("returns undefined when there is no base message and nothing contributes", async () => {
    const repo = await createTempRepo();

    expect(await runCodeModeConnectors(repo, undefined)).toBeUndefined();
  });

  test("emits progress for the pull it attempts, then the skip reason", async () => {
    const repo = await createTempRepo();
    const events: OpenWikiRunEvent[] = [];

    await runCodeModeConnectors(repo, "base", (event) => {
      events.push(event);
    });

    const text = events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join("");
    // The pull is announced so the pre-agent gap reads as progress, and the
    // unconfigured repo reports the skip rather than silently doing nothing.
    expect(text).toContain("Ingesting from");
    expect(text).toContain("LangSmith is not configured for this repository");
  });

  test("tolerates a present last-update timestamp without failing", async () => {
    const repo = await createTempRepo();
    // A valid openwiki/.last-update.json exercises the metadata-read and
    // numeric-window branch; the unconfigured connector still skips, so the base
    // message survives unchanged.
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    await writeFile(
      path.join(repo, "openwiki", ".last-update.json"),
      JSON.stringify({ updatedAt: new Date().toISOString() }),
      "utf8",
    );

    expect(await runCodeModeConnectors(repo, "keep me")).toBe("keep me");
  });
});
