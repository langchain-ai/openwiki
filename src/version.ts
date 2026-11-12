import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The shape of the fields we read out of a `package.json` while searching for
 * OpenWiki's own manifest. Everything is optional because we parse arbitrary
 * `package.json` files encountered while walking up the tree and only accept the
 * one that is actually OpenWiki's.
 */
interface OwnPackageJson {
  /**
   * The package name. Used to confirm a candidate manifest is OpenWiki's own
   * and not a parent/monorepo `package.json`.
   *
   * @default undefined — treated as "not OpenWiki's manifest", keep walking up.
   */
  name?: string;

  /**
   * The published semver string, the single source of truth surfaced as
   * {@link OPENWIKI_VERSION}.
   *
   * @default undefined — treated as "not a usable manifest", keep walking up.
   */
  version?: string;
}

/**
 * Fallback returned when no OpenWiki `package.json` can be found (should never
 * happen in a real install; guards against a corrupt or unexpected layout so a
 * version read never throws and never breaks a run).
 */
const UNKNOWN_VERSION = "0.0.0-unknown";

/**
 * Walks up from `startDir` (default: this module's own location, via
 * `import.meta.url`) looking for the `package.json` whose `name` is
 * `"openwiki"`, and returns the directory containing it — OpenWiki's own
 * package root. This works from source (`src/version.ts`), from the built
 * `dist/`, and from an installed `node_modules/openwiki/dist/`, because
 * every one of those sits below the manifest being searched for. Returns
 * `undefined` if no such manifest is found (should never happen in a real
 * install).
 */
function findOwnPackageRoot(
  startDir: string = path.dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  let dir = startDir;

  for (;;) {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(dir, "package.json"), "utf8"),
      ) as OwnPackageJson;

      if (pkg.name === "openwiki") {
        return dir;
      }
    } catch {
      // No readable/parseable package.json here; keep walking up.
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * OpenWiki's own package root directory (the directory containing its
 * `package.json`), resolved the same way as {@link OPENWIKI_VERSION} — so
 * any code that needs to run something relative to OpenWiki's own install
 * (e.g. spawning one of its scripts as a subprocess) doesn't have to rely on
 * `process.cwd()`, which is only correct when the current process happens to
 * have been launched from inside that directory.
 */
export const OPENWIKI_PACKAGE_ROOT = findOwnPackageRoot();

/**
 * Reads OpenWiki's version from the `package.json` at `root`, reusing the
 * root already resolved by {@link OPENWIKI_PACKAGE_ROOT} instead of walking
 * the directory tree again.
 */
function readOwnVersion(root: string | undefined): string {
  if (!root) {
    return UNKNOWN_VERSION;
  }

  try {
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as OwnPackageJson;
    return typeof pkg.version === "string" ? pkg.version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

/**
 * OpenWiki's published version, derived at runtime from `package.json` so it
 * stays in lockstep with releases without a hardcoded constant to maintain.
 */
export const OPENWIKI_VERSION = readOwnVersion(OPENWIKI_PACKAGE_ROOT);

/**
 * OpenWiki's OKF producer actor, the `by` value stamped on code-owned
 * `generated` and `verified` events (OKF v0.2 §7 `<producer>/<version>`
 * convention). Every deterministic provenance and trust projection derives
 * from this single source so actor identity cannot drift.
 */
export const OPENWIKI_PRODUCER_ACTOR = `openwiki/${OPENWIKI_VERSION}`;
