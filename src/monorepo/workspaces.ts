import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * One entry in the managed `workspaces` list of `openwiki/workspaces.json`.
 * `path` is a repository-root-relative POSIX path (no globs at runtime;
 * auto-detect expands globs before writing the manifest).
 *
 * The `workspaces` list is DETECTION-OWNED: self-maintaining discovery
 * regenerates it (path-only, sorted) on every recursive run. Hand-authored
 * customization lives in the sibling `overrides` map, never on these entries.
 * `goal`/`name` remain optional here only for backward-compatible reading of the
 * legacy flat schema (see {@link normalizeManifest}); on read they are migrated
 * into `overrides`, and the next write emits path-only entries.
 */
export interface WorkspaceEntry {
  path: string;
  goal?: string;
  name?: string;
}

/**
 * A hand-authored customization for one workspace path, keyed by that path in
 * the manifest's `overrides` map. This is the single place for all manual edits,
 * so self-maintaining discovery can regenerate the `workspaces` list wholesale
 * without clobbering user intent.
 *
 * - `goal` / `name`: per-subproject wiki brief and display name overrides.
 * - `exclude`: when true, the path is NOT documented (no sub-wiki run) even if
 *   detection surfaces it. It remains listed in `workspaces` so it is not
 *   re-discovered as new noise; the run set filters it out.
 * - `include`: when true, the path is force-added to the run set even if
 *   detection does not surface it (a custom grouping detection cannot find).
 *   This is also the signal that distinguishes a deliberate manual addition from
 *   an orphaned override left behind by a deleted project.
 */
export interface WorkspaceOverride {
  goal?: string;
  name?: string;
  exclude?: boolean;
  include?: boolean;
}

/**
 * The parsed `openwiki/workspaces.json` manifest. `version` is 1.
 *
 * The current schema separates the DETECTION-OWNED `workspaces` list (auto
 * regenerated each recursive run, sorted, path-only) from the HAND-AUTHORED
 * `overrides` map (keyed by repo-relative path, never auto-clobbered). The
 * legacy flat shape (`workspaces:[{path, goal?, name?}]`, no `overrides`) is
 * still read: {@link normalizeManifest} migrates any per-entry goal/name into
 * `overrides` in memory, and the next write emits the current shape.
 */
export interface WorkspaceManifest {
  version: number;
  workspaces: WorkspaceEntry[];
  overrides?: Record<string, WorkspaceOverride>;
  root?: { goal?: string };
}

/**
 * A validated, normalized workspace run target.
 */
export interface ResolvedWorkspaceRun {
  /** Repository-root-relative POSIX path (normalized, no trailing slash). */
  relativePath: string;
  /** Host absolute path to the subproject directory. */
  absolutePath: string;
  /** Optional per-subproject wiki brief from the manifest. */
  goal?: string;
  /** Optional display name from the manifest. */
  name?: string;
}

/**
 * The fully resolved recursion plan: subproject runs plus the optional root brief.
 */
export interface ResolvedWorkspacePlan {
  runs: ResolvedWorkspaceRun[];
  rootGoal?: string;
}

export const WORKSPACES_MANIFEST_RELATIVE_PATH = "openwiki/workspaces.json";

/**
 * The outcome of deciding whether a run should recurse across a monorepo.
 *
 * - `recurse`: run the orchestrator with `manifest`.
 * - `plain`: run a single ordinary run (no recursion).
 */
export type RecursionActivation =
  | { kind: "recurse"; manifest: WorkspaceManifest; autoDetected: boolean }
  | { kind: "plain"; reason: string };

/**
 * Decides whether to recurse, honoring the product rules and keeping the
 * workspace manifest self-maintaining:
 * - `recursive === false`: force off, even if a manifest exists.
 * - otherwise recurse when `--recursive` is set OR a manifest already exists;
 *   `recursive` unset with no manifest is a plain run.
 *
 * On every recursive run, detection is re-run (it is deterministic and fast) and
 * MERGED with the existing manifest so the manifest stays current as the repo
 * evolves — new projects auto-appear, deleted ones drop out, and hand-authored
 * customization survives:
 * - The managed `workspaces` list is regenerated as the union of the freshly
 *   detected (pruned-to-resolvable) paths and any override paths marked
 *   `include: true` (manual additions detection cannot find), sorted, path-only.
 *   An excluded path detection still surfaces stays listed so it is not
 *   re-discovered as new noise; it is filtered out of the RUN set downstream.
 * - The `overrides` map is preserved from the existing manifest, EXCEPT orphans:
 *   an override whose path is neither detected nor marked `include` (i.e. the
 *   project it customized was deleted or moved) is dropped and a warning is
 *   emitted via `onWarn`.
 * - The result is written back ONLY if it differs from disk (idempotent), so a
 *   no-op run leaves the file byte-for-byte unchanged and CI produces no
 *   spurious manifest diff.
 *
 * `onWarn` receives a human-readable message for each pruned orphan override;
 * callers wire it to the run's event stream. It defaults to a no-op.
 */
export async function resolveRecursionActivation(
  repoRoot: string,
  recursive: boolean | undefined,
  onWarn: (message: string) => void = () => {},
): Promise<RecursionActivation> {
  if (recursive === false) {
    return {
      kind: "plain",
      reason: "recursion disabled with --recursive=false",
    };
  }

  const existing = await readWorkspaceManifest(repoRoot);
  const manifestPresent = existing !== null;

  if (!manifestPresent && recursive !== true) {
    return { kind: "plain", reason: "no openwiki/workspaces.json manifest" };
  }

  // Detection is deterministic and cheap, so re-run it every recursive run and
  // merge with the existing manifest. Prune to a resolvable (leaf-only) set:
  // never persist a manifest that cannot be resolved, or a poisoned
  // openwiki/workspaces.json would make every future default run auto-recurse
  // into a throw.
  const detected = pruneToResolvableWorkspaces(
    repoRoot,
    await detectWorkspaces(repoRoot),
  );

  // Pre-resolve directory existence for every non-detected path the existing
  // manifest referenced, so mergeManifest can stay pure/synchronous. A manual
  // grouping detection cannot find is preserved only when its directory really
  // exists; a removed project's directory is gone, so it is dropped.
  const existingDirs = await resolveExistingManualDirs(
    repoRoot,
    existing,
    new Set(detected.map((entry) => entry.path)),
  );
  const merged = mergeManifest(detected, existing, onWarn, (relativePath) =>
    existingDirs.has(relativePath),
  );

  if (!manifestPresent && merged.workspaces.length === 0) {
    // `--recursive` was requested with no manifest and nothing to document:
    // fall back to a plain run WITHOUT writing an empty manifest.
    return {
      kind: "plain",
      reason:
        "--recursive requested but no monorepo workspaces were detected (pnpm-workspace.yaml, package.json workspaces, Cargo.toml [workspace], go.work, *.sln/*.slnx, Maven pom.xml modules, settings.gradle[.kts], pyproject.toml [tool.uv.workspace], Bazel MODULE.bazel/WORKSPACE)",
    };
  }

  await writeWorkspaceManifestIfChanged(repoRoot, merged);

  return { kind: "recurse", manifest: merged, autoDetected: !manifestPresent };
}

/**
 * Merges freshly detected paths with an existing manifest into the canonical,
 * deterministic manifest to persist. See {@link resolveRecursionActivation} for
 * the merge rules; this is the pure core (no I/O) so it is easy to reason about
 * and test.
 *
 * `pathExists(relativePath)` reports whether a non-detected path still exists as
 * a real directory on disk. It is the discriminator that keeps a manual manifest
 * safe: a workspace path detection cannot surface but whose directory still
 * exists is a deliberate manual grouping (preserved, promoted to an explicit
 * `include`); one whose directory is gone is a removed project (dropped — and
 * warned about only when it carried a hand-authored override, so removals of
 * plain managed entries stay quiet as the feature intends). Injected (not read
 * here) so this core stays pure; the caller backs it with a real stat. It
 * defaults to "nothing extra exists", which matches pure detected-only merges.
 */
export function mergeManifest(
  detected: WorkspaceEntry[],
  existing: WorkspaceManifest | null,
  onWarn: (message: string) => void = () => {},
  pathExists: (relativePath: string) => boolean = () => false,
): WorkspaceManifest {
  const byPath = (left: string, right: string): number =>
    left.localeCompare(right);

  const detectedPaths = [...new Set(detected.map((entry) => entry.path))].sort(
    byPath,
  );
  const detectedSet = new Set(detectedPaths);
  const overrides = existing?.overrides ?? {};

  // Candidate manual paths: any path the existing manifest referenced (managed
  // workspace entry OR override key) that detection no longer surfaces. A bare
  // path-only legacy entry lives ONLY in `workspaces`, so it must be considered
  // here too — otherwise it would be silently dropped without even a warning.
  const candidatePaths = new Set<string>();
  for (const entry of existing?.workspaces ?? []) {
    if (!detectedSet.has(entry.path)) {
      candidatePaths.add(entry.path);
    }
  }
  for (const key of Object.keys(overrides)) {
    if (!detectedSet.has(key)) {
      candidatePaths.add(key);
    }
  }

  // Decide which candidates survive as manual includes. Keep a path that is an
  // explicit include OR whose directory still exists (a manual grouping). Drop
  // the rest: warn when the dropped path had a hand-authored override (intent is
  // being discarded), stay quiet for a plain managed entry that was removed.
  const survivingIncludes = new Set<string>();
  for (const candidate of [...candidatePaths].sort(byPath)) {
    const override = overrides[candidate];
    if (override?.include === true || pathExists(candidate)) {
      survivingIncludes.add(candidate);
    } else if (override) {
      onWarn(
        `Dropping orphaned workspace override for "${candidate}": the path is no longer detected or present. Mark it "include": true to keep it.`,
      );
    }
  }

  // Build the managed list detected-first (detected leaves are guaranteed
  // non-overlapping and always win), then fold in surviving includes only when
  // they do not overlap an already-accepted path. This restores the "never
  // persist a manifest that cannot be resolved" invariant for the include union,
  // which pruneToResolvableWorkspaces (detected-only, upstream) cannot cover.
  const effectivePaths: string[] = [...detectedPaths];
  for (const candidate of [...survivingIncludes].sort(byPath)) {
    const overlaps = effectivePaths.some(
      (accepted) =>
        accepted === candidate ||
        isAncestorPath(candidate, accepted) ||
        isAncestorPath(accepted, candidate),
    );
    if (overlaps) {
      survivingIncludes.delete(candidate);
      onWarn(
        `Ignoring workspace include "${candidate}": it overlaps a detected workspace and would make the manifest unresolvable.`,
      );
      continue;
    }
    effectivePaths.push(candidate);
  }

  const workspaces: WorkspaceEntry[] = [...new Set(effectivePaths)]
    .sort(byPath)
    .map((relativePath) => ({ path: relativePath }));

  // Kept overrides (sorted for a stable, idempotent write): detected paths keep
  // their override verbatim; surviving includes are persisted with include:true
  // (promoting a bare manual entry, or a goal-only legacy entry, into an
  // explicit include so it is stable and future removal routes through the
  // orphan warning). Dropped paths carry no override forward.
  const keptOverrides: Record<string, WorkspaceOverride> = {};
  for (const key of [
    ...new Set([...Object.keys(overrides), ...survivingIncludes]),
  ].sort(byPath)) {
    if (detectedSet.has(key)) {
      keptOverrides[key] = overrides[key];
    } else if (survivingIncludes.has(key)) {
      keptOverrides[key] = { ...(overrides[key] ?? {}), include: true };
    }
  }

  return {
    version: 1,
    workspaces,
    ...(Object.keys(keptOverrides).length > 0
      ? { overrides: keptOverrides }
      : {}),
    ...(existing?.root ? { root: existing.root } : {}),
  };
}

/**
 * Stats every non-detected path referenced by the existing manifest (managed
 * entries and override keys) and returns the subset whose repo-relative
 * directory actually exists. mergeManifest uses this to tell a real manual
 * grouping (keep) from a removed project (drop). Best-effort and safe: paths
 * that fail validation (absolute/`..`) or are absent simply do not appear.
 */
async function resolveExistingManualDirs(
  repoRoot: string,
  existing: WorkspaceManifest | null,
  detectedPaths: Set<string>,
): Promise<Set<string>> {
  const candidates = new Set<string>();
  for (const entry of existing?.workspaces ?? []) {
    if (!detectedPaths.has(entry.path)) {
      candidates.add(entry.path);
    }
  }
  for (const key of Object.keys(existing?.overrides ?? {})) {
    if (!detectedPaths.has(key)) {
      candidates.add(key);
    }
  }

  const present = new Set<string>();
  await Promise.all(
    [...candidates].map(async (relativePath) => {
      let normalized: string;
      try {
        normalized = normalizeWorkspacePath(relativePath);
      } catch {
        return;
      }
      if (normalized === "" || normalized === ".") {
        return;
      }
      const dirStat = await stat(path.join(repoRoot, normalized)).catch(
        () => null,
      );
      if (dirStat?.isDirectory()) {
        present.add(relativePath);
      }
    }),
  );

  return present;
}

/**
 * Returns a workspace set that resolveWorkspaceRuns accepts. If the raw detected
 * set already resolves, it is returned unchanged; otherwise overlaps are pruned
 * by dropping any entry that is an ancestor of another, keeping the leaves.
 */
function pruneToResolvableWorkspaces(
  repoRoot: string,
  detected: WorkspaceEntry[],
): WorkspaceEntry[] {
  try {
    resolveWorkspaceRuns(repoRoot, { version: 1, workspaces: detected });
    return detected;
  } catch {
    const leaves = new Set(
      dropAncestorPaths(detected.map((entry) => entry.path)),
    );
    return detected.filter((entry) => leaves.has(entry.path));
  }
}

/**
 * Serializes a manifest to its canonical, stable on-disk form: fixed top-level
 * key order (version, workspaces, overrides, root), sorted `workspaces`, sorted
 * `overrides` keys with fixed field order, undefined/empty fields omitted, and a
 * trailing newline. Re-serializing an already-canonical manifest is a no-op,
 * which is what makes the idempotent write check byte-exact.
 */
export function serializeManifest(manifest: WorkspaceManifest): string {
  const canonical: Record<string, unknown> = { version: 1 };

  canonical.workspaces = [...manifest.workspaces]
    .map((entry) => ({ path: entry.path }))
    .sort((left, right) => left.path.localeCompare(right.path));

  if (manifest.overrides && Object.keys(manifest.overrides).length > 0) {
    const overrides: Record<string, WorkspaceOverride> = {};
    for (const key of Object.keys(manifest.overrides).sort((left, right) =>
      left.localeCompare(right),
    )) {
      const override = manifest.overrides[key];
      const canonicalOverride: WorkspaceOverride = {};
      if (override.goal !== undefined) canonicalOverride.goal = override.goal;
      if (override.name !== undefined) canonicalOverride.name = override.name;
      if (override.exclude !== undefined) {
        canonicalOverride.exclude = override.exclude;
      }
      if (override.include !== undefined) {
        canonicalOverride.include = override.include;
      }
      overrides[key] = canonicalOverride;
    }
    canonical.overrides = overrides;
  }

  if (manifest.root?.goal !== undefined) {
    canonical.root = { goal: manifest.root.goal };
  }

  return `${JSON.stringify(canonical, null, 2)}\n`;
}

/**
 * Writes a manifest to openwiki/workspaces.json in canonical form so the user
 * can review and edit it. Written with a comment-free JSON body and a trailing
 * newline.
 */
/**
 * Safely writes a generated file that lives inside a repository OpenWiki is
 * documenting. Both the path AND its contents are attacker-influenced (the repo
 * under documentation is untrusted input), so a plain `writeFile` is unsafe:
 * `writeFile` follows symlinks, so a repo that commits the destination as a
 * symlink (e.g. `openwiki/workspaces.md` -> `~/.bashrc`) would have that target
 * silently overwritten with generated content when a developer runs recursive
 * OpenWiki. Guard against it:
 *
 * 1. `lstat` the destination and refuse if it is a symlink (do NOT follow it).
 * 2. `realpath` the parent directory and refuse if it resolves outside the repo
 *    root (a symlinked ancestor directory would otherwise escape the repo).
 *
 * Throws on a rejected path so a malicious layout fails loudly rather than
 * writing through the link.
 */
export async function writeGeneratedFile(
  repoRoot: string,
  absolutePath: string,
  content: string,
): Promise<void> {
  const parentDir = path.dirname(absolutePath);
  await mkdir(parentDir, { recursive: true });

  // The parent must resolve to a real location inside the repo. realpath follows
  // symlinks, so a symlinked ancestor pointing outside the repo is caught here.
  const realRepoRoot = await realpath(repoRoot);
  const realParent = await realpath(parentDir);
  const relativeParent = path.relative(realRepoRoot, realParent);
  if (
    relativeParent !== "" &&
    (relativeParent.startsWith("..") || path.isAbsolute(relativeParent))
  ) {
    throw new Error(
      `Refusing to write ${JSON.stringify(
        path.relative(repoRoot, absolutePath),
      )}: its directory resolves outside the repository (symlink escape).`,
    );
  }

  // The destination itself must not be a symlink; writeFile would follow it and
  // clobber the link target. lstat does not follow the final component.
  const existing = await lstat(absolutePath).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new Error(
      `Refusing to write ${JSON.stringify(
        path.relative(repoRoot, absolutePath),
      )}: the destination is a symlink; writing would follow it and overwrite an arbitrary file.`,
    );
  }

  await writeFile(absolutePath, content, "utf8");
}

export async function writeWorkspaceManifest(
  repoRoot: string,
  manifest: WorkspaceManifest,
): Promise<void> {
  const manifestPath = path.join(repoRoot, WORKSPACES_MANIFEST_RELATIVE_PATH);
  await writeGeneratedFile(
    repoRoot,
    manifestPath,
    serializeManifest(manifest),
  );
}

/**
 * Idempotent write: serializes the target manifest and writes it ONLY when the
 * bytes differ from what is already on disk. A no-op recursive run therefore
 * leaves openwiki/workspaces.json untouched (same mtime, same bytes), so CI does
 * not produce a spurious manifest diff. Returns true when a write happened.
 */
export async function writeWorkspaceManifestIfChanged(
  repoRoot: string,
  manifest: WorkspaceManifest,
): Promise<boolean> {
  const manifestPath = path.join(repoRoot, WORKSPACES_MANIFEST_RELATIVE_PATH);
  const target = serializeManifest(manifest);

  const current = await readFileIfPresent(manifestPath);
  if (current === target) {
    return false;
  }

  await writeGeneratedFile(repoRoot, manifestPath, target);
  return true;
}

/**
 * Reads and structurally validates `openwiki/workspaces.json` at the repo root.
 * Returns null when the manifest is absent. Throws on malformed JSON or a
 * structurally invalid manifest so activation fails loudly rather than silently
 * degrading to a plain run.
 */
export async function readWorkspaceManifest(
  repoRoot: string,
): Promise<WorkspaceManifest | null> {
  const manifestPath = path.join(repoRoot, WORKSPACES_MANIFEST_RELATIVE_PATH);

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `openwiki/workspaces.json is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  return normalizeManifest(parsed);
}

/**
 * Normalizes an untrusted parsed manifest into a WorkspaceManifest, rejecting
 * structurally invalid input.
 */
export function normalizeManifest(value: unknown): WorkspaceManifest {
  if (!isRecord(value)) {
    throw new Error("openwiki/workspaces.json must be a JSON object.");
  }

  const version = value.version;
  if (version !== undefined && version !== 1) {
    throw new Error(
      `openwiki/workspaces.json version ${JSON.stringify(
        version,
      )} is unsupported; only version 1 is understood.`,
    );
  }

  if (!Array.isArray(value.workspaces)) {
    throw new Error(
      "openwiki/workspaces.json must contain a `workspaces` array.",
    );
  }

  const workspaces: WorkspaceEntry[] = value.workspaces.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.path !== "string") {
      throw new Error(
        `openwiki/workspaces.json workspaces[${index}] must be an object with a string \`path\`.`,
      );
    }

    return {
      path: entry.path,
      goal: typeof entry.goal === "string" ? entry.goal : undefined,
      name: typeof entry.name === "string" ? entry.name : undefined,
    };
  });

  const overrides = normalizeOverrides(value.overrides);

  // Backward compat: migrate any per-entry goal/name from the legacy flat schema
  // into the overrides map (keyed by path). An explicit override wins; the entry
  // only fills fields the override does not already set. This preserves goals a
  // user hand-wrote in the old shape, since the next write emits path-only
  // workspace entries and carries all customization in `overrides`.
  for (const entry of workspaces) {
    if (entry.goal === undefined && entry.name === undefined) {
      continue;
    }
    const existing = overrides[entry.path] ?? {};
    overrides[entry.path] = {
      ...existing,
      ...(existing.goal === undefined && entry.goal !== undefined
        ? { goal: entry.goal }
        : {}),
      ...(existing.name === undefined && entry.name !== undefined
        ? { name: entry.name }
        : {}),
    };
  }

  const rootGoal =
    isRecord(value.root) && typeof value.root.goal === "string"
      ? value.root.goal
      : undefined;

  return {
    version: 1,
    workspaces,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...(rootGoal !== undefined ? { root: { goal: rootGoal } } : {}),
  };
}

/**
 * Normalizes the untrusted `overrides` map, keeping only recognized fields with
 * the right types. A missing or non-object `overrides` yields an empty map; a
 * non-object override value is skipped rather than throwing (the overrides map
 * is hand-authored and best-effort — a stray value must not wedge the run).
 */
function normalizeOverrides(value: unknown): Record<string, WorkspaceOverride> {
  const overrides: Record<string, WorkspaceOverride> = {};
  if (!isRecord(value)) {
    return overrides;
  }

  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) {
      continue;
    }
    const override: WorkspaceOverride = {};
    if (typeof raw.goal === "string") override.goal = raw.goal;
    if (typeof raw.name === "string") override.name = raw.name;
    if (typeof raw.exclude === "boolean") override.exclude = raw.exclude;
    if (typeof raw.include === "boolean") override.include = raw.include;
    overrides[key] = override;
  }

  return overrides;
}

/**
 * Validates, normalizes, dedupes, and rejects overlapping workspace entries,
 * returning an ordered recursion plan (leaves first is the caller's concern;
 * this function preserves manifest order after dedupe).
 *
 * Overrides are applied per path (keyed by the normalized repo-relative path):
 * - `exclude: true` produces NO run for that path (it stays listed in
 *   `workspaces` so it is not re-discovered, but is never documented).
 * - `goal`/`name` take precedence over any legacy per-entry goal/name; the
 *   precedence chain is override → legacy entry → none.
 *
 * Rejections (throw):
 * - absolute paths or paths containing `..` segments (escape attempts)
 * - a workspace equal to the repository root
 * - a workspace that is an ancestor of another (nested/overlapping)
 */
export function resolveWorkspaceRuns(
  repoRoot: string,
  manifest: WorkspaceManifest,
): ResolvedWorkspacePlan {
  const overrides = manifest.overrides ?? {};
  const seen = new Set<string>();
  const runs: ResolvedWorkspaceRun[] = [];

  for (const entry of manifest.workspaces) {
    const relativePath = normalizeWorkspacePath(entry.path);

    if (relativePath === "" || relativePath === ".") {
      throw new Error(
        `Invalid workspace path ${JSON.stringify(
          entry.path,
        )}: a workspace may not be the repository root (it collides with the root wiki).`,
      );
    }

    if (seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);

    // An excluded path is validated and de-duped like any other (so overlap
    // checks stay honest) but produces no run — it is listed only so detection
    // does not re-surface it as new noise.
    const override = overrides[relativePath];
    if (override?.exclude === true) {
      continue;
    }

    const goal = override?.goal ?? entry.goal;
    const name = override?.name ?? entry.name;

    runs.push({
      relativePath,
      absolutePath: path.resolve(repoRoot, relativePath),
      goal: goal?.trim() ? goal.trim() : undefined,
      name: name?.trim() ? name.trim() : undefined,
    });
  }

  assertNoOverlappingWorkspaces(runs);

  return {
    runs,
    rootGoal: manifest.root?.goal?.trim()
      ? manifest.root.goal.trim()
      : undefined,
  };
}

/**
 * Normalizes a manifest workspace path to a repo-root-relative POSIX path,
 * rejecting absolute paths and `..` traversal (mirrors the normalization in
 * isOpenWikiDocsPath and adds traversal rejection).
 */
function normalizeWorkspacePath(rawPath: string): string {
  const withForwardSlashes = rawPath.trim().replace(/\\/gu, "/");

  if (withForwardSlashes.startsWith("/")) {
    throw new Error(
      `Invalid workspace path ${JSON.stringify(
        rawPath,
      )}: absolute paths are not allowed. Use a path relative to the repository root.`,
    );
  }

  const normalized = path.posix.normalize(withForwardSlashes);
  const trimmed = normalized.replace(/\/+$/u, "").replace(/^\.\//u, "");

  if (
    trimmed === ".." ||
    trimmed.startsWith("../") ||
    trimmed.split("/").includes("..")
  ) {
    throw new Error(
      `Invalid workspace path ${JSON.stringify(
        rawPath,
      )}: paths may not escape the repository root with "..".`,
    );
  }

  return trimmed;
}

/**
 * Throws when any workspace is an ancestor of another (nested/overlapping).
 */
function assertNoOverlappingWorkspaces(runs: ResolvedWorkspaceRun[]): void {
  for (const outer of runs) {
    for (const inner of runs) {
      if (outer === inner) {
        continue;
      }

      if (isAncestorPath(outer.relativePath, inner.relativePath)) {
        throw new Error(
          `Overlapping workspaces: "${outer.relativePath}" is an ancestor of "${inner.relativePath}". No workspace may be an ancestor of another.`,
        );
      }
    }
  }
}

/**
 * True when `ancestor` is a strict path-segment ancestor of `descendant`.
 */
function isAncestorPath(ancestor: string, descendant: string): boolean {
  const ancestorSegments = ancestor.split("/");
  const descendantSegments = descendant.split("/");

  if (ancestorSegments.length >= descendantSegments.length) {
    return false;
  }

  return ancestorSegments.every(
    (segment, index) => segment === descendantSegments[index],
  );
}

const WORKSPACE_MANIFEST_CANDIDATES = ["package.json", "Cargo.toml", "go.mod"];

/**
 * Confirms a resolved workspace directory is a real subtree of the repository
 * (rejecting symlink escapes) and carries some evidence worth documenting.
 * Returns a reason string when the workspace should be skipped, or null when it
 * is runnable.
 */
export async function getWorkspaceSkipReason(
  repoRoot: string,
  run: ResolvedWorkspaceRun,
): Promise<string | null> {
  let realWorkspace: string;
  let realRepoRoot: string;
  try {
    realWorkspace = await realpath(run.absolutePath);
    realRepoRoot = await realpath(repoRoot);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return `directory "${run.relativePath}" does not exist`;
    }
    throw error;
  }

  const relativeFromRoot = path.relative(realRepoRoot, realWorkspace);
  if (
    relativeFromRoot === "" ||
    relativeFromRoot.startsWith("..") ||
    path.isAbsolute(relativeFromRoot)
  ) {
    return `directory "${run.relativePath}" resolves outside the repository (symlink escape)`;
  }

  const workspaceStat = await stat(realWorkspace).catch(() => null);
  if (!workspaceStat?.isDirectory()) {
    return `"${run.relativePath}" is not a directory`;
  }

  // A workspace is worth documenting if it has a package manifest, an
  // INSTRUCTIONS.md brief, an explicit goal, or any non-trivial source content.
  if (run.goal) {
    return null;
  }

  const hasInstructions = await pathExists(
    path.join(run.absolutePath, "openwiki", "INSTRUCTIONS.md"),
  );
  if (hasInstructions) {
    return null;
  }

  for (const candidate of WORKSPACE_MANIFEST_CANDIDATES) {
    if (await pathExists(path.join(run.absolutePath, candidate))) {
      return null;
    }
  }

  const hasSource = await directoryHasNonWikiEntries(run.absolutePath);
  if (!hasSource) {
    return `"${run.relativePath}" has no package manifest, no openwiki/INSTRUCTIONS.md, no goal, and no source files`;
  }

  return null;
}

async function directoryHasNonWikiEntries(directory: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  return entries.some(
    (entry) =>
      !entry.name.startsWith(".") &&
      entry.name !== "openwiki" &&
      entry.name !== "node_modules",
  );
}

/**
 * Auto-detects workspaces from common monorepo manifests, expanding any globs
 * into concrete, existing directories. Order of precedence: pnpm-workspace.yaml,
 * package.json `workspaces`, Cargo.toml `[workspace] members`, go.work `use`
 * directives, .NET `*.sln`/`*.slnx` project entries, Maven `pom.xml` modules,
 * Gradle `settings.gradle[.kts]` includes, Python uv
 * `[tool.uv.workspace] members`, then coarse Bazel top-level project roots.
 * Returns [] when nothing is detected.
 */
export async function detectWorkspaces(
  repoRoot: string,
): Promise<WorkspaceEntry[]> {
  const globs = await collectWorkspaceGlobs(repoRoot);
  if (globs.length === 0) {
    return [];
  }

  const relativePaths = new Set<string>();
  for (const glob of globs) {
    for (const match of await expandWorkspaceGlob(repoRoot, glob)) {
      relativePaths.add(match);
    }
  }

  return [...relativePaths]
    .sort((left, right) => left.localeCompare(right))
    .map((relativePath) => ({ path: relativePath }));
}

/**
 * Gathers raw workspace globs/paths from every recognized manifest.
 *
 * Precedence order: JS/TS (pnpm-workspace.yaml, package.json), Rust
 * (Cargo.toml), Go (go.work), .NET (*.sln / *.slnx), Java/JVM (Maven pom.xml
 * modules, Gradle settings.gradle[.kts] includes), Python (uv
 * [tool.uv.workspace]), then Bazel (coarse top-level project roots).
 */
async function collectWorkspaceGlobs(repoRoot: string): Promise<string[]> {
  const globs: string[] = [];

  const pnpmGlobs = await readPnpmWorkspaceGlobs(repoRoot);
  globs.push(...pnpmGlobs);

  const packageJsonGlobs = await readPackageJsonWorkspaceGlobs(repoRoot);
  globs.push(...packageJsonGlobs);

  const cargoGlobs = await readCargoWorkspaceGlobs(repoRoot);
  globs.push(...cargoGlobs);

  const goWorkGlobs = await readGoWorkGlobs(repoRoot);
  globs.push(...goWorkGlobs);

  const dotnetGlobs = await readDotnetSolutionGlobs(repoRoot);
  globs.push(...dotnetGlobs);

  const mavenGlobs = await readMavenModuleGlobs(repoRoot);
  globs.push(...mavenGlobs);

  const gradleGlobs = await readGradleIncludeGlobs(repoRoot);
  globs.push(...gradleGlobs);

  const uvGlobs = await readUvWorkspaceGlobs(repoRoot);
  globs.push(...uvGlobs);

  const bazelGlobs = await readBazelWorkspaceGlobs(repoRoot);
  globs.push(...bazelGlobs);

  return dedupeStrings(
    globs.map((glob) => glob.trim()).filter((glob) => glob.length > 0),
  );
}

async function readPnpmWorkspaceGlobs(repoRoot: string): Promise<string[]> {
  const raw = await readFileIfPresent(
    path.join(repoRoot, "pnpm-workspace.yaml"),
  );
  if (raw === null) {
    return [];
  }

  try {
    const parsed: unknown = parseYaml(raw);
    if (isRecord(parsed) && Array.isArray(parsed.packages)) {
      return parsed.packages.filter(
        (value): value is string => typeof value === "string",
      );
    }
  } catch {
    return [];
  }

  return [];
}

async function readPackageJsonWorkspaceGlobs(
  repoRoot: string,
): Promise<string[]> {
  const raw = await readFileIfPresent(path.join(repoRoot, "package.json"));
  if (raw === null) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }

  const workspaces = parsed.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter(
      (value): value is string => typeof value === "string",
    );
  }

  if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
    return workspaces.packages.filter(
      (value): value is string => typeof value === "string",
    );
  }

  return [];
}

async function readCargoWorkspaceGlobs(repoRoot: string): Promise<string[]> {
  const raw = await readFileIfPresent(path.join(repoRoot, "Cargo.toml"));
  if (raw === null) {
    return [];
  }

  // Minimal TOML extraction: find the [workspace] section and its `members`
  // array. Avoids a TOML dependency for this narrow detection use.
  const workspaceSection = /\[workspace\]([\s\S]*?)(?:\n\[|$)/u.exec(raw);
  if (!workspaceSection) {
    return [];
  }

  const membersMatch = /members\s*=\s*\[([\s\S]*?)\]/u.exec(
    workspaceSection[1],
  );
  if (!membersMatch) {
    return [];
  }

  return [...membersMatch[1].matchAll(/["']([^"']+)["']/gu)].map(
    (match) => match[1],
  );
}

async function readGoWorkGlobs(repoRoot: string): Promise<string[]> {
  const raw = await readFileIfPresent(path.join(repoRoot, "go.work"));
  if (raw === null) {
    return [];
  }

  const paths: string[] = [];
  const blockMatch = /use\s*\(([\s\S]*?)\)/u.exec(raw);
  if (blockMatch) {
    for (const line of blockMatch[1].split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith("//")) {
        paths.push(trimmed);
      }
    }
  }

  for (const match of raw.matchAll(/^\s*use\s+([^\s(][^\s]*)\s*$/gmu)) {
    paths.push(match[1]);
  }

  return paths.map((value) => value.replace(/^\.\//u, ""));
}

/**
 * The GUID that marks a "solution folder" (a virtual organizational grouping)
 * in a classic `.sln` file. Solution-folder entries are not real projects and
 * their path field is just a folder name, so they must be skipped.
 */
const SLN_SOLUTION_FOLDER_TYPE_GUID = "2150E333-8FDC-42A3-9474-1A3956D46DE8";

const SLN_PROJECT_EXTENSIONS = [".csproj", ".vbproj", ".fsproj"];

/**
 * Reads .NET solution files at the repo root and returns the directory of every
 * referenced project. Both the classic `*.sln` format and the newer XML
 * `*.slnx` format (default from `dotnet new sln` on .NET 9+) are handled; all
 * solution files in the repo root are scanned (not recursively).
 *
 * Classic `.sln` lists projects as lines like:
 *   Project("{TYPE-GUID}") = "Name", "relative\path\Foo.csproj", "{PROJ-GUID}"
 * The second quoted field is the project path (backslash-separated). Verified
 * `.slnx` schema against Microsoft docs / vs-solutionpersistence: an XML
 * `<Solution>` with `<Project Path="relative\path\Foo.csproj" />` entries and
 * `<Folder>` elements for organizational folders. In both formats only entries
 * whose path ends in a real project extension (.csproj/.vbproj/.fsproj) are
 * emitted, which naturally excludes classic solution-folder entries (marked by
 * the type GUID 2150E333-... with a bare folder name) and slnx `<Folder>`s.
 */
async function readDotnetSolutionGlobs(repoRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(repoRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (lower.endsWith(".sln")) {
      dirs.push(...(await readClassicSlnProjectDirs(repoRoot, entry.name)));
    } else if (lower.endsWith(".slnx")) {
      dirs.push(...(await readSlnxProjectDirs(repoRoot, entry.name)));
    }
  }

  return coarsenDotnetProjectDirs(dirs);
}

/**
 * Coarsens raw .NET project directories up to their product-area roots.
 *
 * The .NET DDD convention nests each project under an intermediate `src/` or
 * `tests/` directory inside its product area, e.g.
 *   platform/core/admission/src/Core.Admission.Api
 *   platform/core/admission/src/Core.Admission.Domain
 *   platform/core/admission/tests/Core.Admission.Domain.Tests
 * all belong to the ONE area `platform/core/admission`. Emitting one workspace
 * per `.csproj` is far too granular for this feature (a large monorepo yields
 * hundreds of projects, hence hundreds of agent runs); the intended unit is the
 * product area / bounded context.
 *
 * Rule: for a project directory whose IMMEDIATE parent segment is exactly `src`
 * or `tests`, drop the trailing `/src/<projectDir>` or `/tests/<projectDir>` to
 * reach the area root — but ONLY when the resulting area is non-empty and is not
 * itself literally `src` or `tests`. Two guards enforce that:
 *   1. `segments.length >= 3` (there is something above the `src`/`tests`
 *      parent), so a top-level `src/Api` is left unchanged instead of collapsing
 *      to the repository root.
 *   2. `area !== "src"` and `area !== "tests"`, so idiomatic layouts where the
 *      area segment is itself `src`/`tests` (e.g. a top-level `src/tests/App.Tests`,
 *      or `src/src/Foo`) are NOT collapsed to a bare `src`/`tests` — that would
 *      make one wiki span the entire source (or test) tree, the exact granularity
 *      this coarsening exists to prevent.
 * Flatter libs whose project directory sits directly under a container (e.g.
 * `kernel/Core.Domain.Kernel`, whose parent `kernel` is neither `src` nor
 * `tests`) are left unchanged. After coarsening, ancestor paths are dropped so
 * the result is a clean, non-overlapping set of area/lib leaves.
 *
 * Known edge (data-dependent, accepted): coarsen-then-drop-ancestor can drop a
 * project that sits directly in an area (`area/Y.csproj` -> `area`) when a
 * sibling sits deeper under a non-`src`/`tests` intermediate (`area/group/Z`,
 * left granular), because `area` then becomes an ancestor of `area/group/Z` and
 * is dropped. This is inherent to coarsening + overlap-pruning and low-frequency
 * in practice; auto-detect writes the manifest for human review, so a lost
 * project is recoverable by hand rather than silently unrecoverable.
 *
 * Scoped to .NET on purpose: the pnpm/npm/cargo/go/uv detectors already emit
 * package-level units where a `packages/foo/src/bar` may be a legitimate leaf,
 * so coarsening is applied only to the .sln/.slnx source, not globally.
 */
function coarsenDotnetProjectDirs(dirs: string[]): string[] {
  const coarsened = dirs.map((dir) => {
    const segments = dir.split("/");
    // Require at least <area>/<src|tests>/<projectDir>: the parent must be
    // exactly "src" or "tests", and the trimmed area must be a real area
    // segment (non-empty, and not itself "src"/"tests").
    if (segments.length >= 3) {
      const parent = segments[segments.length - 2];
      if (parent === "src" || parent === "tests") {
        const area = segments.slice(0, -2).join("/");
        if (area !== "" && area !== "src" && area !== "tests") {
          return area;
        }
      }
    }
    return dir;
  });

  return dropAncestorPaths(coarsened);
}

/**
 * Extracts project directories from a classic `.sln` file, skipping
 * solution-folder entries and any non-project path.
 */
async function readClassicSlnProjectDirs(
  repoRoot: string,
  fileName: string,
): Promise<string[]> {
  const raw = await readFileIfPresent(path.join(repoRoot, fileName));
  if (raw === null) {
    return [];
  }

  const dirs: string[] = [];
  const projectLine =
    /Project\("\{([0-9A-Fa-f-]+)\}"\)\s*=\s*"[^"]*",\s*"([^"]+)"/gu;
  for (const match of raw.matchAll(projectLine)) {
    const typeGuid = match[1].toUpperCase();
    if (typeGuid === SLN_SOLUTION_FOLDER_TYPE_GUID) {
      continue;
    }
    const dir = dotnetProjectPathToDir(match[2]);
    if (dir !== null) {
      dirs.push(dir);
    }
  }

  return dirs;
}

/**
 * Extracts project directories from an XML `.slnx` file. Only `<Project>`
 * elements with a real project-file `Path` are emitted; `<Folder>` elements
 * (organizational only) are ignored by the extension check.
 */
async function readSlnxProjectDirs(
  repoRoot: string,
  fileName: string,
): Promise<string[]> {
  const raw = await readFileIfPresent(path.join(repoRoot, fileName));
  if (raw === null) {
    return [];
  }

  const dirs: string[] = [];
  const projectAttr = /<Project\b[^>]*\bPath\s*=\s*["']([^"']+)["']/gu;
  for (const match of raw.matchAll(projectAttr)) {
    const dir = dotnetProjectPathToDir(match[1]);
    if (dir !== null) {
      dirs.push(dir);
    }
  }

  return dirs;
}

/**
 * Normalizes a .NET project path (backslash-separated, may point at a
 * .csproj/.vbproj/.fsproj) to its repo-root-relative directory, or null when
 * the path is not a recognized project file.
 */
function dotnetProjectPathToDir(rawPath: string): string | null {
  const forwardSlashes = rawPath.trim().replace(/\\/gu, "/");
  const lower = forwardSlashes.toLowerCase();
  if (!SLN_PROJECT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return null;
  }
  const dir = path.posix.dirname(forwardSlashes);
  return dir === "." ? "" : dir;
}

/**
 * Reads a parent Maven `pom.xml` at the repo root and returns its `<module>`
 * directories. Each `<module>` is a relative directory (occasionally a dir
 * containing a nested pom). No XML-parser dependency is present, so a narrow
 * regex scoped to the `<modules>` block is used, mirroring the Cargo approach.
 * XML comments inside the block are stripped before extraction so
 * `<!-- <module>x</module> -->` is ignored.
 */
async function readMavenModuleGlobs(repoRoot: string): Promise<string[]> {
  const raw = await readFileIfPresent(path.join(repoRoot, "pom.xml"));
  if (raw === null) {
    return [];
  }

  const modulesBlock = /<modules\b[^>]*>([\s\S]*?)<\/modules>/u.exec(raw);
  if (!modulesBlock) {
    return [];
  }

  const withoutComments = modulesBlock[1].replace(/<!--[\s\S]*?-->/gu, "");
  return [
    ...withoutComments.matchAll(/<module>\s*([^<]+?)\s*<\/module>/gu),
  ].map((match) => match[1].replace(/\\/gu, "/"));
}

/**
 * Reads Gradle settings files (`settings.gradle` Groovy and
 * `settings.gradle.kts` Kotlin) at the repo root and returns the directories of
 * every `include`d project. Gradle project paths use `:` as a separator and map
 * to directories: `:foo:bar` -> `foo/bar` (a leading `:` is stripped, remaining
 * `:` become `/`). Every quoted token following an `include` keyword is
 * extracted, covering `include ':a'`, `include(":a")`, and comma-separated
 * multi-project forms `include ':a', ':b'` / `include(":a", ":b")`.
 *
 * Known limitation (out of scope for v1): `project(':x').projectDir =
 * file('...')` can remap a project to a directory that the default `:`->`/`
 * mapping would not produce. The common convention is covered; remapped
 * projects are not.
 */
async function readGradleIncludeGlobs(repoRoot: string): Promise<string[]> {
  const paths: string[] = [];
  for (const fileName of ["settings.gradle", "settings.gradle.kts"]) {
    const raw = await readFileIfPresent(path.join(repoRoot, fileName));
    if (raw === null) {
      continue;
    }

    // Strip block and line comments first so a commented-out include (whole
    // line or trailing) never leaks a phantom project. `\binclude\b` matches
    // `include` but not `includeBuild` (composite builds are not subprojects).
    const noComments = raw
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/[^\n]*/gu, "");

    // Match an `include` keyword (Groovy `include ...` or Kotlin
    // `include(...)`) and its arguments, spanning continuation lines so that a
    // wrapped, comma-separated list is captured whole. The argument run stops
    // at a `;` or at a newline that does NOT begin a continuation (a line whose
    // first non-space char is a quote, comma, colon, or closing paren).
    for (const stmt of noComments.matchAll(
      /(?:^|;|\n)\s*include\b\s*\(?((?:[^\n;()]|\n(?=\s*['":,)]))*)/gu,
    )) {
      for (const token of stmt[1].matchAll(/["']([^"']+)["']/gu)) {
        const dir = gradleProjectPathToDir(token[1]);
        if (dir.length > 0) {
          paths.push(dir);
        }
      }
    }
  }

  return paths;
}

/**
 * Maps a Gradle project path (`:foo:bar`) to a repo-root-relative directory
 * (`foo/bar`): strip a single leading `:`, then replace remaining `:` with `/`.
 */
function gradleProjectPathToDir(projectPath: string): string {
  return projectPath.trim().replace(/^:/u, "").replace(/:/gu, "/");
}

/**
 * Reads a Python `pyproject.toml` at the repo root and returns the uv workspace
 * `members` globs from the `[tool.uv.workspace]` section. Verified against the
 * current uv docs: `members` (required) and `exclude` (optional) are both lists
 * of globs. `members` entries support `*`, expanded downstream. A narrow regex
 * scoped to the section is used (mirroring the Cargo approach) since no TOML
 * dependency is present.
 *
 * Known limitation (deferred): the optional `exclude` list is NOT honored.
 * Excluded directories that still match a `members` glob and exist on disk will
 * be detected. In practice the downstream skip/overlap guards and manual
 * manifest review absorb this; honoring `exclude` cheaply is possible but was
 * left out of v1 to keep the extractor a pure member-glob reader.
 */
async function readUvWorkspaceGlobs(repoRoot: string): Promise<string[]> {
  const raw = await readFileIfPresent(path.join(repoRoot, "pyproject.toml"));
  if (raw === null) {
    return [];
  }

  const section = /\[tool\.uv\.workspace\]([\s\S]*?)(?:\n\[|$)/u.exec(raw);
  if (!section) {
    return [];
  }

  const membersMatch = /members\s*=\s*\[([\s\S]*?)\]/u.exec(section[1]);
  if (!membersMatch) {
    return [];
  }

  return [...membersMatch[1].matchAll(/["']([^"']+)["']/gu)].map(
    (match) => match[1],
  );
}

/**
 * Detects a Bazel workspace and emits only COARSE top-level project roots.
 *
 * Bazel deliberately has no notion of "workspace member directories": a Bazel
 * *package* is any directory containing a `BUILD`/`BUILD.bazel` file, which in a
 * real repo is hundreds of directories at every depth. Enumerating them all
 * would produce a massive, deeply-overlapping set that is wrong for this feature
 * (which wants "major projects get granular docs", not "every leaf package").
 *
 * So detection is intentionally shallow: presence is inferred from a root
 * `MODULE.bazel` (Bzlmod) or `WORKSPACE`/`WORKSPACE.bazel` (legacy) file, and
 * the emitted set is the immediate child directories of the repo root — and of a
 * conventional `src/` directory if present — that themselves contain a
 * `BUILD`/`BUILD.bazel`. This yields a handful of top-level project roots rather
 * than an explosion of nested packages. If nothing at the top level qualifies,
 * [] is returned: for a deep Bazel tree with no BUILD file at the top level, a
 * hand-authored openwiki/workspaces.json is the right escape hatch, which is
 * strictly better than a wrong, overlapping explosion.
 */
async function readBazelWorkspaceGlobs(repoRoot: string): Promise<string[]> {
  const markers = ["MODULE.bazel", "WORKSPACE.bazel", "WORKSPACE"];
  let hasBazel = false;
  for (const marker of markers) {
    if (await pathExists(path.join(repoRoot, marker))) {
      hasBazel = true;
      break;
    }
  }
  if (!hasBazel) {
    return [];
  }

  const dirs: string[] = [];
  for (const base of ["", "src"]) {
    for (const child of await listSubdirectories(repoRoot, base)) {
      if (await directoryHasBazelBuildFile(repoRoot, child)) {
        dirs.push(child);
      }
    }
  }

  return dirs;
}

/**
 * True when a directory contains a Bazel `BUILD` or `BUILD.bazel` file.
 */
async function directoryHasBazelBuildFile(
  repoRoot: string,
  relativePath: string,
): Promise<boolean> {
  for (const name of ["BUILD.bazel", "BUILD"]) {
    if (await pathExists(path.join(repoRoot, relativePath, name))) {
      return true;
    }
  }
  return false;
}

/**
 * Expands one workspace glob into concrete, existing, repo-relative directory
 * paths. Supports `*` (single segment) and `**` (any depth). A glob with no
 * wildcard is treated as a literal directory path.
 */
async function expandWorkspaceGlob(
  repoRoot: string,
  glob: string,
): Promise<string[]> {
  const normalized = glob
    .replace(/\\/gu, "/")
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "");

  if (normalized === "" || normalized.startsWith("..")) {
    return [];
  }

  const segments = normalized.split("/");
  const matches = (await expandSegments(repoRoot, "", segments)).filter(
    (relativePath) => relativePath !== "" && relativePath !== ".",
  );

  // A `**` glob matches at every depth, so naive expansion emits the container
  // directory AND all intermediates (e.g. `packages/**` → packages, packages/a,
  // packages/a/nested). Tools treat `packages/**` as "the workspace packages",
  // not "every directory under packages". Reduce to LEAF package directories so
  // the detected set never contains a directory that is an ancestor of another
  // match (which resolveWorkspaceRuns would reject as overlapping).
  if (segments.includes("**")) {
    return filterDoubleStarMatchesToLeafPackages(repoRoot, matches);
  }

  return matches;
}

/**
 * Reduces raw `**` matches to leaf workspace packages: prefer directories that
 * are actual package roots (contain a package manifest); if none do, fall back
 * to dropping any directory that is an ancestor of another match.
 */
async function filterDoubleStarMatchesToLeafPackages(
  repoRoot: string,
  matches: string[],
): Promise<string[]> {
  const packageDirs: string[] = [];
  for (const relativePath of matches) {
    if (await directoryHasPackageManifest(repoRoot, relativePath)) {
      packageDirs.push(relativePath);
    }
  }

  if (packageDirs.length > 0) {
    return dropAncestorPaths(packageDirs);
  }

  return dropAncestorPaths(matches);
}

/**
 * True when a directory contains a recognized package manifest.
 */
async function directoryHasPackageManifest(
  repoRoot: string,
  relativePath: string,
): Promise<boolean> {
  for (const candidate of WORKSPACE_MANIFEST_CANDIDATES) {
    if (await pathExists(path.join(repoRoot, relativePath, candidate))) {
      return true;
    }
  }
  return false;
}

/**
 * Removes any path that is a strict ancestor of another path in the set, so
 * only leaves survive. Deduplicates as a side effect.
 */
function dropAncestorPaths(paths: string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter(
    (candidate) =>
      !unique.some(
        (other) => other !== candidate && isAncestorPath(candidate, other),
      ),
  );
}

async function expandSegments(
  repoRoot: string,
  currentRelative: string,
  segments: string[],
): Promise<string[]> {
  if (segments.length === 0) {
    const absolute = path.join(repoRoot, currentRelative);
    const dirStat = await stat(absolute).catch(() => null);
    return dirStat?.isDirectory() ? [currentRelative] : [];
  }

  const [segment, ...rest] = segments;

  if (segment === "**") {
    // Match zero or more directory levels.
    const results: string[] = [];
    results.push(...(await expandSegments(repoRoot, currentRelative, rest)));

    for (const child of await listSubdirectories(repoRoot, currentRelative)) {
      results.push(...(await expandSegments(repoRoot, child, segments)));
    }

    return dedupeStrings(results);
  }

  if (segment.includes("*")) {
    const matcher = globSegmentToRegExp(segment);
    const results: string[] = [];
    for (const child of await listSubdirectories(repoRoot, currentRelative)) {
      const childName = path.posix.basename(child);
      if (matcher.test(childName)) {
        results.push(...(await expandSegments(repoRoot, child, rest)));
      }
    }
    return results;
  }

  const nextRelative = currentRelative
    ? path.posix.join(currentRelative, segment)
    : segment;
  const absolute = path.join(repoRoot, nextRelative);
  const dirStat = await stat(absolute).catch(() => null);
  if (!dirStat?.isDirectory()) {
    return [];
  }
  return expandSegments(repoRoot, nextRelative, rest);
}

async function listSubdirectories(
  repoRoot: string,
  currentRelative: string,
): Promise<string[]> {
  const absolute = path.join(repoRoot, currentRelative);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== "node_modules" &&
        entry.name !== ".git" &&
        !entry.name.startsWith("."),
    )
    .map((entry) =>
      currentRelative
        ? path.posix.join(currentRelative, entry.name)
        : entry.name,
    );
}

function globSegmentToRegExp(segment: string): RegExp {
  const escaped = segment
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, "[^/]*");
  return new RegExp(`^${escaped}$`, "u");
}

async function readFileIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    // ENOENT: absent. EISDIR/ENOTDIR: the name exists but is a directory (or a
    // path component is not a directory), which for manifest detection means
    // "no readable manifest here" — treat as absent rather than letting it
    // propagate and wedge detection for the whole repo.
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Per-subproject generator state persisted at openwiki/.workspaces-state.json.
 * Maps each subproject's repo-relative path to the git HEAD at the time its
 * sub-wiki was last generated, so future runs can reason about which subprojects
 * changed. This file is excluded from the content snapshot and generated
 * indexes (see WORKSPACES_STATE_FILE in agent/utils.ts and EXCLUDED_FILES in
 * okf/index-sync.ts).
 */
export interface WorkspacesState {
  version: 1;
  workspaces: Record<string, { gitHead?: string; updatedAt: string }>;
}

export const WORKSPACES_STATE_RELATIVE_PATH = "openwiki/.workspaces-state.json";

export async function readWorkspacesState(
  repoRoot: string,
): Promise<WorkspacesState> {
  const statePath = path.join(repoRoot, WORKSPACES_STATE_RELATIVE_PATH);
  const raw = await readFileIfPresent(statePath);
  if (raw === null) {
    return { version: 1, workspaces: {} };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && isRecord(parsed.workspaces)) {
      const workspaces: WorkspacesState["workspaces"] = {};
      for (const [key, value] of Object.entries(parsed.workspaces)) {
        if (isRecord(value) && typeof value.updatedAt === "string") {
          workspaces[key] = {
            gitHead:
              typeof value.gitHead === "string" ? value.gitHead : undefined,
            updatedAt: value.updatedAt,
          };
        }
      }
      return { version: 1, workspaces };
    }
  } catch {
    // Corrupt state is non-fatal: treat as empty and let the run rewrite it.
  }

  return { version: 1, workspaces: {} };
}

export async function writeWorkspacesState(
  repoRoot: string,
  state: WorkspacesState,
): Promise<void> {
  const statePath = path.join(repoRoot, WORKSPACES_STATE_RELATIVE_PATH);
  await writeGeneratedFile(
    repoRoot,
    statePath,
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * True when a read failed because the target is absent OR is not a readable
 * file (a directory named like a manifest, or a non-directory path component).
 * All three mean "no manifest to read here" for detection purposes.
 */
function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR";
}
