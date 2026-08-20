/**
 * Supported host identifiers used by CLI parsing and installation.
 */
export type HostTargetId = "codex" | "claude" | "dcode";

/**
 * Current managed installation states exposed to callers.
 */
export type HostIntegrationStatus = "installed" | "modified" | "not-installed";

/**
 * Host-owned MCP configuration destination.
 */
export interface HostMcpConfig {
  /**
   * Config adapter required by the host.
   */
  readonly kind: "json" | "codex-toml";

  /**
   * Config path relative to the target project root.
   */
  readonly relativePath: string;
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
   * Host-owned skill destination relative to the project root.
   */
  readonly skillDirectory: string;

  /**
   * Host-owned MCP config format and path.
   */
  readonly mcpConfig: HostMcpConfig;

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
   * Project receiving the host integration.
   */
  projectRoot: string;

  /**
   * Whether install may preserve and replace unmanaged or modified skill content.
   *
   * @default false
   */
  force?: boolean;
}

/**
 * Options for removing a managed host integration.
 */
export interface UninstallOptions {
  /**
   * Project containing the managed host integration.
   */
  projectRoot: string;
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
