import path from "node:path";

import { openWikiHomeDir } from "../openwiki-home.js";

/**
 * Publishable PostHog project key. Safe to ship (client/ingestion key).
 */
export const DEFAULT_POSTHOG_KEY =
  "phc_Cki9DqcLbYkGudQaiaTSAfQZxXvjL6EyoaQjEJGJrwPF";
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/**
 * Persistent, anonymous per-machine install id.
 */
export const INSTALL_ID_PATH = path.join(openWikiHomeDir, "install-id");

/**
 * Longest we wait for the event send (and the client shutdown) before letting
 * the short-lived CLI exit, so telemetry can never stall a run.
 */
export const FLUSH_TIMEOUT_MS = 3000;

/**
 * The single usage event OpenWiki emits. Everything (mode, provider, outcome,
 * latency, environment, configured connectors) rides on this one event.
 */
export const TELEMETRY_RUN_EVENT = "openwiki_run";

/**
 * The one-time disclosure copy, single-sourced here. Stored unwrapped so each
 * surface wraps it to its own width: the interactive TUI renders these in an Ink
 * box, and the print/non-TTY path frames and wraps them (see cli.tsx).
 */
export const FIRST_RUN_NOTICE_BODY =
  "OpenWiki collects anonymous, aggregate usage data: which command you run (init or update), the brain mode and model provider you set up, whether runs succeed or fail (and a general error category), and which connectors you configured. No file contents, repository data, credentials, prompts, model output, IP address, or personal information are ever collected.";
export const FIRST_RUN_NOTICE_OPT_OUT =
  "Opt out anytime: set OPENWIKI_TELEMETRY_DISABLED=1 (or DO_NOT_TRACK=1). Add it to ~/.openwiki/.env to make it permanent.";
export const FIRST_RUN_NOTICE_VERIFY =
  "To see what data we capture, add the --telemetry-file=<path> to any run.";
