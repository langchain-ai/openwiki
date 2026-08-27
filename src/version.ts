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
 * Reads OpenWiki's own version from its `package.json` at module load, so the
 * runtime version can never drift from the published one. Starts at this
 * module's own location (`import.meta.url`) and walks up the directory tree,
 * accepting the first `package.json` whose `name` is `"openwiki"`. This works
 * from source (`src/version.ts`), from the built `dist/`, and from an installed
 * `node_modules/openwiki/dist/`, because every one of those sits below the
 * manifest we are looking for.
 */
function readOwnVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));

  for (;;) {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(dir, "package.json"), "utf8"),
      ) as OwnPackageJson;

      if (pkg.name === "openwiki" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // No readable/parseable package.json here; keep walking up.
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return UNKNOWN_VERSION;
    }
    dir = parent;
  }
}

/**
 * OpenWiki's published version, derived at runtime from `package.json` so it
 * stays in lockstep with releases without a hardcoded constant to maintain.
 */
export const OPENWIKI_VERSION = readOwnVersion();

/**
 * OpenWiki's OKF producer actor, the `by` value stamped on code-owned
 * `generated` and `verified` events (OKF v0.2 §7 `<producer>/<version>`
 * convention). Every deterministic provenance and trust projection derives
 * from this single source so actor identity cannot drift.
 */
export const OPENWIKI_PRODUCER_ACTOR = `openwiki/${OPENWIKI_VERSION}`;
