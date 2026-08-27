/**
 * Supported host identifiers used by CLI parsing and installation.
 */
export type HostTargetId = "codex" | "claude" | "opencode";

/**
 * Current managed installation states exposed to callers.
 */
export type HostIntegrationStatus =
  "installed" | "modified" | "not-installed" | "unsupported";

/**
 * Supported ownership scopes for host integration files.
 */
export type HostIntegrationScope = "user" | "project";

/**
 * Executable invocation used to start the OpenWiki MCP server.
 */
export interface HostMcpServerCommand {
  /**
   * Executable launched directly by the coding host.
   */
  readonly command: string;

  /**
   * Ordered arguments passed to the executable.
   */
  readonly args: readonly string[];
}

/**
 * Host-owned MCP configuration destination.
 */
export interface HostMcpConfig {
  /**
   * Config adapter required by the host.
   */
  readonly kind: "json" | "codex-toml" | "opencode-json";

  /**
   * Config path relative to the selected scope root.
   */
  readonly relativePath: string;
}

/**
 * Host-owned destinations within one installation scope.
 */
export interface HostInstallationPaths {
  /**
   * Skill destination relative to the selected scope root.
   */
  readonly skillDirectory: string;

  /**
   * MCP config format and destination for the selected scope.
   */
  readonly mcpConfig: HostMcpConfig;
}

/**
 * Registry entry describing one compatible coding host.
 */
export interface HostTarget {
  /**
   * Stable CLI and metadata identifier.
   */
  readonly id: HostTargetId;

  /**
   * Human-readable product name.
   */
  readonly displayName: string;

  /**
   * Stable OKF producer stamped on page bodies authored by this host.
   */
  readonly producerActor: string;

  /**
   * User-level destinations relative to the user's home directory.
   */
  readonly user: HostInstallationPaths | null;

  /**
   * Project-level destinations relative to the target repository.
   */
  readonly project: HostInstallationPaths;

  /**
   * Public setup documentation for the host's MCP support.
   */
  readonly documentationUrl: string;
}

/**
 * Options for installing or upgrading a host integration.
 */
export interface InstallOptions {
  /**
   * Ownership scope receiving the host integration.
   */
  scope: HostIntegrationScope;

  /**
   * Home or project directory anchoring the selected scope.
   */
  root: string;

  /**
   * Whether install may preserve and replace unmanaged or modified skill content.
   *
   * @default false
   */
  force?: boolean;

  /**
   * Internal executable override used by repository development tooling.
   *
   * @default undefined - launch the installed `openwiki` executable.
   */
  mcpServerCommand?: HostMcpServerCommand;
}

/**
 * Options for removing a managed host integration.
 */
export interface UninstallOptions {
  /**
   * Ownership scope containing the managed host integration.
   */
  scope: HostIntegrationScope;

  /**
   * Home or project directory anchoring the selected scope.
   */
  root: string;
}

/**
 * Paths and mutation status returned by an installation operation.
 */
export interface InstallResult {
  /**
   * Host target affected by the operation.
   */
  target: HostTargetId;

  /**
   * Ownership scope affected by the operation.
   */
  scope: HostIntegrationScope;

  /**
   * Absolute installed skill directory.
   */
  skillDirectory: string;

  /**
   * Absolute MCP configuration path.
   */
  mcpConfig: string;

  /**
   * Whether the requested operation changed managed state.
   */
  changed: boolean;

  /**
   * Retained backup path when replacement or cleanup could not remove it.
   *
   * @default undefined - no backup remains.
   */
  backupPath?: string;
}
