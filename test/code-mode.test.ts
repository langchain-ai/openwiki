import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";
import { ensureCodeModeRepoSetup } from "../src/code-mode.ts";

const SNIPPET_START = "<!-- OPENWIKI:START -->";
const SNIPPET_END = "<!-- OPENWIKI:END -->";

const tempRepos: string[] = [];
const stderrSpies: MockInstance<typeof process.stderr.write>[] = [];

/**
 * Capture writes to stderr for the current test. Spies are restored in
 * `afterEach` so a failed assertion can never leak a live mock that would
 * swallow stderr for the rest of the worker.
 */
function captureStderr(): MockInstance<typeof process.stderr.write> {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  stderrSpies.push(spy);
  return spy;
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

function backupPathFor(agentsPath: string): string {
  return `${agentsPath}.openwiki.bak`;
}

function canonicalFile(): string {
  return `# Custom header\n\nKeep me.\n\n${SNIPPET_START}

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with \`openwiki/quickstart.md\`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

${SNIPPET_END}\n`;
}

function nonCanonicalFile(): string {
  return `# Custom header

User content INSIDE the managed block that must not be lost.

${SNIPPET_START}
hand-edited block content
${SNIPPET_END}

Trailing notes.
`;
}

afterEach(async () => {
  await Promise.all(
    tempRepos
      .splice(0)
      .map((repo) => rm(repo, { force: true, recursive: true })),
  );
  for (const spy of stderrSpies.splice(0)) {
    spy.mockRestore();
  }
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

  test("refreshes the OpenWiki block in place and preserves surrounding content", async () => {
    const repo = await createTempRepo();
    const existing = `# My Project

Hand-written guidance for coding agents.

${SNIPPET_START}
stale OpenWiki content
${SNIPPET_END}

Trailing notes that must survive.
`;
    const claudePath = path.join(repo, "CLAUDE.md");
    await writeFile(claudePath, existing, "utf8");
    const stderr = captureStderr();

    await ensureCodeModeRepoSetup(repo);

    const content = await readIfPresent(claudePath);
    expect(content).toContain("# My Project");
    expect(content).toContain("Hand-written guidance for coding agents.");
    expect(content).toContain("Trailing notes that must survive.");
    expect(content).not.toContain("stale OpenWiki content");
    // Exactly one managed block after a refresh.
    expect(content?.match(new RegExp(SNIPPET_START, "g"))).toHaveLength(1);
    // The stale (non-canonical) block content was backed up, never silently.
    const backup = await readIfPresent(backupPathFor(claudePath));
    expect(backup).toBe(existing);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("CLAUDE.md.openwiki.bak"),
    );
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
      // Validation runs before any backup is written, so an aborted run
      // leaves no backup for either file.
      expect(await readIfPresent(backupPathFor(agentsPath))).toBeNull();
      expect(
        await readIfPresent(backupPathFor(path.join(repo, "CLAUDE.md"))),
      ).toBeNull();
    });
  }
});

describe("ensureCodeModeRepoSetup workflow", () => {
  test("generated PR includes agent files, backups, and the workflow in add-paths", async () => {
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
      "AGENTS.md.openwiki.bak",
      "CLAUDE.md.openwiki.bak",
      ".github/workflows/openwiki-update.yml",
    ]) {
      expect(workflow).toContain(managedPath);
    }
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

describe("non-canonical block protection", () => {
  test("backs up a non-canonical block before replacing it and warns", async () => {
    const repo = await createTempRepo();
    const agentsPath = path.join(repo, "AGENTS.md");
    const existing = nonCanonicalFile();
    await writeFile(agentsPath, existing, "utf8");
    const stderr = captureStderr();

    await ensureCodeModeRepoSetup(repo);

    const content = await readIfPresent(agentsPath);
    expect(content).not.toContain("hand-edited block content");
    expect(content).toContain("## OpenWiki");
    expect(content).toContain("Trailing notes.");
    const backup = await readIfPresent(backupPathFor(agentsPath));
    expect(backup).toBe(existing);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("AGENTS.md"));
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("AGENTS.md.openwiki.bak"),
    );
  });

  test("leaves a canonical block untouched: no warning, no backup, no rewrite", async () => {
    const repo = await createTempRepo();
    const claudePath = path.join(repo, "CLAUDE.md");
    const canonical = canonicalFile();
    await writeFile(claudePath, canonical, "utf8");
    const before = await stat(claudePath);
    const stderr = captureStderr();

    await ensureCodeModeRepoSetup(repo);

    expect(await readIfPresent(claudePath)).toBe(canonical);
    const after = await stat(claudePath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(stderr).not.toHaveBeenCalled();
    expect(await readIfPresent(backupPathFor(claudePath))).toBeNull();
  });

  test("treats a CRLF canonical block as canonical, preserving line endings", async () => {
    const repo = await createTempRepo();
    const claudePath = path.join(repo, "CLAUDE.md");
    const crlf = canonicalFile().replace(/\n/g, "\r\n");
    await writeFile(claudePath, crlf, "utf8");
    const before = await stat(claudePath);
    const stderr = captureStderr();

    await ensureCodeModeRepoSetup(repo);

    expect(await readIfPresent(claudePath)).toBe(crlf);
    const after = await stat(claudePath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(stderr).not.toHaveBeenCalled();
    expect(await readIfPresent(backupPathFor(claudePath))).toBeNull();
  });

  test("treats a lone-CR canonical block as canonical, preserving line endings", async () => {
    const repo = await createTempRepo();
    const claudePath = path.join(repo, "CLAUDE.md");
    const cr = canonicalFile().replace(/\n/g, "\r");
    await writeFile(claudePath, cr, "utf8");
    const before = await stat(claudePath);
    const stderr = captureStderr();

    await ensureCodeModeRepoSetup(repo);

    expect(await readIfPresent(claudePath)).toBe(cr);
    const after = await stat(claudePath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(stderr).not.toHaveBeenCalled();
    expect(await readIfPresent(backupPathFor(claudePath))).toBeNull();
  });

  test("malformed markers in one file abort before any backup for the sibling", async () => {
    const repo = await createTempRepo();
    const agentsPath = path.join(repo, "AGENTS.md");
    const claudePath = path.join(repo, "CLAUDE.md");
    await writeFile(
      agentsPath,
      `# Project\n\n${SNIPPET_START}\norphaned start marker\n`,
      "utf8",
    );
    await writeFile(claudePath, nonCanonicalFile(), "utf8");

    await expect(ensureCodeModeRepoSetup(repo)).rejects.toThrow(
      /managed markers are malformed or duplicated/u,
    );

    expect(await readIfPresent(agentsPath)).toContain("orphaned start marker");
    expect(await readIfPresent(claudePath)).toContain(
      "hand-edited block content",
    );
    expect(await readIfPresent(backupPathFor(agentsPath))).toBeNull();
    expect(await readIfPresent(backupPathFor(claudePath))).toBeNull();
  });

  test("overwrites a previous backup on a second non-canonical run and says so", async () => {
    const repo = await createTempRepo();
    const agentsPath = path.join(repo, "AGENTS.md");
    await writeFile(agentsPath, nonCanonicalFile(), "utf8");
    await ensureCodeModeRepoSetup(repo);
    const firstBackup = await readIfPresent(backupPathFor(agentsPath));
    const secondStale = nonCanonicalFile().replace(
      "hand-edited block content",
      "second round of hand edits",
    );
    await writeFile(agentsPath, secondStale, "utf8");
    const stderr = captureStderr();

    await ensureCodeModeRepoSetup(repo);

    expect(await readIfPresent(backupPathFor(agentsPath))).toBe(secondStale);
    expect(firstBackup).not.toBe(secondStale);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("replaced"));
  });

  test("clobbering a pre-existing backup file is named in the warning", async () => {
    const repo = await createTempRepo();
    const agentsPath = path.join(repo, "AGENTS.md");
    await writeFile(agentsPath, nonCanonicalFile(), "utf8");
    const backupPath = backupPathFor(agentsPath);
    await writeFile(backupPath, "pre-existing user file", "utf8");
    const stderr = captureStderr();

    await ensureCodeModeRepoSetup(repo);

    expect(await readIfPresent(backupPath)).toBe(nonCanonicalFile());
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("replaced"));
  });

  test("a failing backup aborts the run before any agent file is written", async () => {
    const repo = await createTempRepo();
    const agentsPath = path.join(repo, "AGENTS.md");
    await writeFile(agentsPath, nonCanonicalFile(), "utf8");
    // A directory occupying the backup name makes the atomic rename fail.
    await mkdir(backupPathFor(agentsPath));

    await expect(ensureCodeModeRepoSetup(repo)).rejects.toThrow();

    expect(await readIfPresent(agentsPath)).toContain(
      "hand-edited block content",
    );
    expect(await readIfPresent(path.join(repo, "CLAUDE.md"))).toBeNull();
  });

  test("never auto-deletes an orphaned backup once the block is canonical", async () => {
    const repo = await createTempRepo();
    const claudePath = path.join(repo, "CLAUDE.md");
    await writeFile(claudePath, nonCanonicalFile(), "utf8");
    await ensureCodeModeRepoSetup(repo);
    const backup = await readIfPresent(backupPathFor(claudePath));
    expect(backup).not.toBeNull();

    await ensureCodeModeRepoSetup(repo);

    expect(await readIfPresent(backupPathFor(claudePath))).toBe(backup);
  });

  test("backs up the target content of a symlinked agent file", async () => {
    const repo = await createTempRepo();
    const targetPath = path.join(repo, "real-agents.md");
    await writeFile(targetPath, nonCanonicalFile(), "utf8");
    const linkPath = path.join(repo, "AGENTS.md");
    await symlink(targetPath, linkPath);

    await ensureCodeModeRepoSetup(repo);

    const linkStat = await lstat(linkPath);
    expect(linkStat.isSymbolicLink()).toBe(true);
    const backup = await readIfPresent(backupPathFor(linkPath));
    expect(backup).toBe(nonCanonicalFile());
  });

  test("marker-less files get the append path with no warning or backup", async () => {
    const repo = await createTempRepo();
    const agentsPath = path.join(repo, "AGENTS.md");
    const existing = "# Existing AGENTS\n\nDo not lose this line.\n";
    await writeFile(agentsPath, existing, "utf8");
    const stderr = captureStderr();

    await ensureCodeModeRepoSetup(repo);

    expect(await readIfPresent(agentsPath)).toContain(SNIPPET_START);
    expect(stderr).not.toHaveBeenCalled();
    expect(await readIfPresent(backupPathFor(agentsPath))).toBeNull();
  });
});

describe("ensureCodeModeRepoSetup onWarning sink", () => {
  test("delivers warnings to a custom sink instead of stderr", async () => {
    const repo = await createTempRepo();
    const agentsPath = path.join(repo, "AGENTS.md");
    await writeFile(agentsPath, nonCanonicalFile(), "utf8");
    const warnings: string[] = [];
    const stderr = captureStderr();

    await ensureCodeModeRepoSetup(repo, {
      onWarning: (message) => warnings.push(message),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("AGENTS.md.openwiki.bak");
    expect(stderr).not.toHaveBeenCalled();
  });

  test("a throwing sink falls back to stderr without breaking the run", async () => {
    const repo = await createTempRepo();
    const agentsPath = path.join(repo, "AGENTS.md");
    await writeFile(agentsPath, nonCanonicalFile(), "utf8");
    const stderr = captureStderr();

    await ensureCodeModeRepoSetup(repo, {
      onWarning: () => {
        throw new Error("sink exploded");
      },
    });

    expect(await readIfPresent(agentsPath)).toContain("## OpenWiki");
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("AGENTS.md.openwiki.bak"),
    );
  });

  test("warns for each affected file, once per file, in agent-file order", async () => {
    const repo = await createTempRepo();
    const agentsPath = path.join(repo, "AGENTS.md");
    const claudePath = path.join(repo, "CLAUDE.md");
    await writeFile(agentsPath, nonCanonicalFile(), "utf8");
    await writeFile(claudePath, nonCanonicalFile(), "utf8");
    const warnings: string[] = [];

    await ensureCodeModeRepoSetup(repo, {
      onWarning: (message) => warnings.push(message),
    });

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("AGENTS.md");
    expect(warnings[1]).toContain("CLAUDE.md");
  });
});
