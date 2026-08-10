/**
 * Bakes the distribution channel into the build. Run only on the official
 * release path (via the `release` npm script, before `tsc`): it rewrites the one
 * `BUILD_CHANNEL` assignment in `src/telemetry/gates.ts` from the committed
 * `"community"` default to the value of `OPENWIKI_BUILD_CHANNEL`. Any unset or
 * unrecognized value resolves to `"community"`, so an unexpected env value can
 * never mint an `"official"` build. The rewrite is ephemeral in CI (a throwaway
 * checkout that is never committed back), so the committed source stays
 * `"community"` for forks, local builds, and dev runs.
 *
 * Usage: `node scripts/stamp-build-channel.cjs [targetFile]`. The optional target
 * defaults to the real gates.ts; tests pass a temp file.
 */
const { readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

/** The closed set of channels a build may be stamped with. */
const BUILD_CHANNELS = ["community", "official"];

/** Where the constant lives when no explicit target is given. */
const DEFAULT_TARGET = path.resolve(
  __dirname,
  "..",
  "src",
  "telemetry",
  "gates.ts",
);

/**
 * Matches the committed `const BUILD_CHANNEL: BuildChannel = "…"` assignment,
 * capturing everything up to the string literal so only the value is rewritten.
 */
const ASSIGNMENT = /(const BUILD_CHANNEL: BuildChannel = )"[^"]*"/u;

/**
 * Resolves a requested channel to a member of the closed set, defaulting any
 * unset or unrecognized value to "community". Fail-safe: only an explicit,
 * recognized "official" ever produces an official build.
 */
function resolveBuildChannel(requested) {
  return BUILD_CHANNELS.includes(requested) ? requested : "community";
}

/**
 * Rewrites the BUILD_CHANNEL assignment in `source` to `channel`, leaving the
 * rest of the file (docstring, imports, the other gates) untouched. Throws if the
 * expected assignment is not present exactly once, so a drifted file fails the
 * release loudly instead of silently publishing an unstamped build.
 */
function stampSource(source, channel) {
  const occurrences = source.match(new RegExp(ASSIGNMENT, "gu"));
  if (!occurrences || occurrences.length !== 1) {
    throw new Error(
      `expected exactly one BUILD_CHANNEL assignment to stamp, found ${
        occurrences ? occurrences.length : 0
      }`,
    );
  }
  return source.replace(ASSIGNMENT, `$1"${channel}"`);
}

/**
 * Reads the target, stamps it with the resolved channel, and writes it back only
 * when the content actually changes (so a no-op community stamp leaves the file
 * byte-identical and the working tree clean).
 */
function main(targetFile) {
  const target = targetFile ? path.resolve(targetFile) : DEFAULT_TARGET;
  const channel = resolveBuildChannel(process.env.OPENWIKI_BUILD_CHANNEL);
  const source = readFileSync(target, "utf8");
  const stamped = stampSource(source, channel);
  if (stamped !== source) {
    writeFileSync(target, stamped, "utf8");
  }
  console.log(`stamp-build-channel: ${channel} (${target})`);
}

if (require.main === module) {
  try {
    main(process.argv[2]);
  } catch (error) {
    console.error(
      `stamp-build-channel failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
}

module.exports = { BUILD_CHANNELS, resolveBuildChannel, stampSource };
