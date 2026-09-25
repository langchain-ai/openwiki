/**
 * Copies browser assets that TypeScript does not emit into the visualizer
 * distribution directory. The list is explicit so adding another asset is a
 * one-line change, and every copy is verified before the build can succeed.
 */
const { copyFileSync, existsSync, statSync } = require("node:fs");
const path = require("node:path");

/** Browser assets required by the compiled visualizer. */
const ASSETS = [
  {
    source: path.resolve(__dirname, "..", "src", "visualize", "styles.css"),
    destination: path.resolve(
      __dirname,
      "..",
      "dist",
      "visualize",
      "styles.css",
    ),
  },
];

/** Copy one asset and fail if the resulting destination is unusable. */
function copyAsset({ source, destination }) {
  if (!existsSync(source)) {
    throw new Error(`source asset is missing: ${source}`);
  }
  // tsc creates dist/visualize/ on its way to client.js, so a missing directory
  // means this ran without (or before) a build rather than that a copy failed.
  const destinationDir = path.dirname(destination);
  if (!existsSync(destinationDir)) {
    throw new Error(
      `destination directory does not exist (run the build first): ${destinationDir}`,
    );
  }
  copyFileSync(source, destination);
  if (!existsSync(destination) || statSync(destination).size === 0) {
    throw new Error(`destination asset is missing or empty: ${destination}`);
  }
}

function main() {
  for (const asset of ASSETS) copyAsset(asset);
  const noun = ASSETS.length === 1 ? "asset" : "assets";
  console.log(`copy-visualize-assets: copied ${ASSETS.length} ${noun}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      `copy-visualize-assets failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
}

module.exports = { ASSETS, copyAsset };
