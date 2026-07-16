import { MANAGED_ENV_KEYS } from "../../env.js";
import { isSecretLikeKey } from "../../diagnostics.js";

/**
 * Environment keys the agent CLI is allowed to inherit from the parent.
 *
 * Intentionally minimal: enough for PATH lookup, home-directory session
 * files (`~/.grok`, `~/.gemini/antigravity-cli`), temp dirs, locale, and
 * corporate proxy/CA setup. Everything else — especially OpenWiki-managed
 * credentials — is dropped.
 */
const PASSTHROUGH_ENV_KEYS = new Set([
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USER",
  "USERNAME",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "SHELL",
  "ComSpec",
  "COMSPEC",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
]);

const MANAGED_ENV_KEY_SET = new Set<string>(MANAGED_ENV_KEYS);

/**
 * Builds a scrubbed environment for vendor agent-CLI children.
 *
 * Drops every {@link MANAGED_ENV_KEYS} entry (provider keys, OAuth tokens,
 * connector secrets), secret-like keys, and OpenWiki/LangChain config so a
 * prompt-injected shell step or compromised binary cannot read credentials
 * that OpenWiki loaded into `process.env`.
 */
export function buildAgentCliChildEnv(
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) {
      continue;
    }

    if (!shouldPassEnvKey(key)) {
      continue;
    }

    env[key] = value;
  }

  return env;
}

/** Exported for tests. */
export function shouldPassEnvKey(key: string): boolean {
  if (MANAGED_ENV_KEY_SET.has(key)) {
    return false;
  }

  if (isSecretLikeKey(key)) {
    return false;
  }

  // Defense in depth: never forward OpenWiki or LangChain/LangSmith vars even
  // when they are not in MANAGED_ENV_KEYS (e.g. future keys, LANGCHAIN_ENDPOINT).
  if (
    key.startsWith("OPENWIKI_") ||
    key.startsWith("LANGCHAIN_") ||
    key.startsWith("LANGSMITH_")
  ) {
    return false;
  }

  if (key.startsWith("LC_")) {
    return true;
  }

  return PASSTHROUGH_ENV_KEYS.has(key) || key === "LANG";
}
