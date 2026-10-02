import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { ClaimsStore } from "../../src/claims/brains/code/store.ts";
import {
  getCurrentRepositoryPageCompletion,
  readRepositoryPageManifest,
} from "../../src/generation/page-manifest.ts";
import {
  beginRepositoryRun,
  captureRepositoryPageSnapshot,
  finishRepositoryRun,
  getRepositoryRunSourceCheckpoint,
  nextRepositoryPage,
  skipRepositoryPage,
  submitRepositoryPage,
  submitRepositoryPlan,
} from "../../src/generation/repository-run.ts";
import { readRepositoryRunState } from "../../src/generation/run-state.ts";

const execFileAsync = promisify(execFile);
const actor = {
  producerActor: "host-agent/test",
  metadataModel: "test-model",
};
let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

test("finishing a skipped verified page preserves its Markdown and coverage", async () => {
  root = await mkdtemp(path.join(tmpdir(), "openwiki-skipped-verification-"));
  const cwd = root;
  await execFileAsync("git", ["init", "--quiet"], { cwd });
  await execFileAsync("git", ["config", "user.name", "OpenWiki Test"], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd,
  });
  await writeFile(path.join(root, "README.md"), "# Repository\n");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "--quiet", "-m", "initial"], { cwd });

  const page = "/openwiki/quickstart.md";
  const initialized = await beginRepositoryRun({ root, mode: "init", actor });
  if (!("run" in initialized)) throw new Error("Expected an init run.");
  await submitRepositoryPlan(initialized.run, {
    pages: [
      { path: page, title: "Quickstart", purpose: "Introduce the repository." },
    ],
  });
  const initialJob = await nextRepositoryPage(initialized.run);
  if (initialJob.status !== "pending") throw new Error("Expected a page job.");
  const written = await initialized.run.backend.write(
    page,
    "---\ntype: Guide\ntitle: Quickstart\n---\n\n# Quickstart\n\nThe repository has a README.\n",
  );
  expect(written.error).toBeFalsy();
  await submitRepositoryPage(initialized.run, {
    jobId: initialJob.job.id,
    claims: [
      {
        statement: "The repository has a README.",
        evidence: [{ resource: "repo://README.md" }],
      },
    ],
  });
  await finishRepositoryRun(initialized.run);

  const store = new ClaimsStore(root);
  const baseline = await store.loadPage(page);
  expect(baseline?.verification).toBeDefined();
  expect(baseline?.claims).toHaveLength(1);
  expect(baseline?.pageVersion).toBe(await store.hashPage(page));
  const priorCoverage = (await readRepositoryPageManifest(root)).pages[page];
  expect(priorCoverage).toBeDefined();

  const updated = await beginRepositoryRun({
    root,
    mode: "update",
    force: true,
    actor,
  });
  if (!("run" in updated)) throw new Error("Expected an update run.");
  await submitRepositoryPlan(updated.run, {
    pages: [{ path: page, title: "Quickstart", purpose: "Refresh the guide." }],
  });
  const job = await nextRepositoryPage(updated.run);
  if (job.status !== "pending") throw new Error("Expected a page job.");
  const snapshot = await captureRepositoryPageSnapshot(updated.run, job.job.id);
  await updated.run.backend.write(page, "# Incomplete worker output\n");
  await skipRepositoryPage(updated.run, snapshot);
  expect(await store.readMarkdown(page)).toBe(snapshot.markdown);
  expect(await store.loadPage(page)).toEqual(snapshot.claims);

  await expect(
    finishRepositoryRun(updated.run, {
      skippedPageSnapshots: [snapshot],
    }),
  ).resolves.toEqual({ status: "complete" });

  expect(await store.readMarkdown(page)).toBe(snapshot.markdown);
  expect(await store.loadPage(page)).toEqual(snapshot.claims);
  expect((await store.loadPage(page))?.pageVersion).toBe(
    await store.hashPage(page),
  );
  expect((await readRepositoryPageManifest(root)).pages[page]).toEqual(
    priorCoverage,
  );
  expect(
    await getCurrentRepositoryPageCompletion(
      root,
      page,
      getRepositoryRunSourceCheckpoint(updated.run.state),
    ),
  ).toEqual(priorCoverage);
  expect(await readRepositoryRunState(root)).toBeNull();
  expect(
    JSON.parse(
      await readFile(path.join(root, "openwiki/.last-update.json"), "utf8"),
    ),
  ).toMatchObject({ status: "interrupted" });
}, 20_000);
