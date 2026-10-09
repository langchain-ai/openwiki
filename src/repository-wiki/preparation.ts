import {
  persistRepositoryWikiConfig,
  RepositoryWikiConfigError,
  resolveRepositoryWikiLocation,
  type RepositoryWikiLocation,
} from "./config.js";
import {
  inspectRepositoryWikiOwnership,
  type RepositoryWikiOwnership,
} from "./ownership.js";
import { DEFAULT_REPOSITORY_WIKI_DIRECTORY } from "./paths.js";

/**
 * Repository lifecycle modes that may prepare a wiki directory selection.
 */
export type RepositoryWikiPreparationMode = "init" | "update";

/**
 * Inputs shared by native CLI and coding-agent wiki preparation.
 */
export interface PrepareRepositoryWikiLocationOptions {
  /**
   * Repository lifecycle operation requesting the wiki location.
   */
  mode: RepositoryWikiPreparationMode;

  /**
   * Optional bootstrap or recovery directory supplied by the user.
   */
  requestedDirectory?: string | null;

  /**
   * Validates and reports a required config write without persisting it.
   */
  dryRun?: boolean;
}

/**
 * Validated repository wiki preparation shared by every frontend.
 */
export interface PreparedRepositoryWikiLocation {
  /**
   * Contained physical location to use for the complete repository run.
   */
  location: RepositoryWikiLocation;

  /**
   * Configuration persistence performed or planned by preparation.
   */
  configAction: "none" | "persisted" | "planned";

  /**
   * Existing target ownership inspected for a custom selection.
   */
  ownership?: RepositoryWikiOwnership;
}

/**
 * Validates and prepares one wiki location for CLI or coding-agent execution.
 */
export async function prepareRepositoryWikiLocation(
  repositoryRoot: string,
  options: PrepareRepositoryWikiLocationOptions,
): Promise<PreparedRepositoryWikiLocation> {
  const location = await resolveRepositoryWikiLocation(
    repositoryRoot,
    options.requestedDirectory,
  );

  if (location.source === "config") {
    return {
      location,
      configAction: "none",
    };
  }

  if (location.directory === DEFAULT_REPOSITORY_WIKI_DIRECTORY) {
    return {
      location,
      configAction: "none",
    };
  }

  const ownership = await inspectRepositoryWikiOwnership(
    repositoryRoot,
    location.directory,
  );
  assertSelectableOwnership(options.mode, location.directory, ownership);

  if (options.dryRun !== true) {
    await persistRepositoryWikiConfig(repositoryRoot, location.directory);
  }

  return {
    location,
    configAction: options.dryRun === true ? "planned" : "persisted",
    ownership,
  };
}

/**
 * Rejects target ownership that cannot safely support the requested lifecycle.
 */
function assertSelectableOwnership(
  mode: RepositoryWikiPreparationMode,
  directory: string,
  ownership: RepositoryWikiOwnership,
): void {
  if (ownership.status === "unsafe") {
    throw new RepositoryWikiConfigError(
      `Cannot use repository wiki directory ${JSON.stringify(directory)}: ${ownership.reason}.`,
    );
  }
  if (mode === "update" && ownership.status !== "managed") {
    throw new RepositoryWikiConfigError(
      `Cannot recover repository wiki configuration from ${JSON.stringify(directory)} because it is not an existing OpenWiki-managed wiki.`,
    );
  }
  if (mode === "init" && ownership.status === "unmanaged") {
    throw new RepositoryWikiConfigError(
      `Cannot initialize repository wiki directory ${JSON.stringify(directory)} because it contains ${ownership.entryCount} unmanaged entries.`,
    );
  }
}
