import type { MutableRefObject } from "react";
import type { OpenWikiCommand, OpenWikiRunResult } from "../../agent/types.js";
import type { CredentialDiagnostic } from "../../config/env.js";
import type { OpenWikiIngestionResult } from "../../ingestion/ingestion.js";
import type { InitSetupResult } from "../../setup/credentials.js";
import type { AuthFix } from "../diagnostics/auth-fix.js";
import type { ErrorDiagnostic } from "../diagnostics/error-diagnostics.js";
import type { RunLogItem } from "../run-log/types.js";

/**
 * The App's finite run lifecycle. Each variant carries exactly the data its
 * render branch needs: streaming logs while a run is live, the result and any
 * opt-in credential diagnostics once it settles, and the concise message plus
 * allowlisted error diagnostics and auth "how to fix" context on failure.
 */
export type RunState =
  | { status: "idle" }
  | { status: "setup-complete-exit"; result: InitSetupResult }
  | { status: "init-setup-saved"; result: InitSetupResult }
  | {
      status: "ingestion-running";
      log: RunLogItem[];
      credentialDiagnostics?: CredentialDiagnostic[];
    }
  | {
      status: "ingestion-success";
      result: OpenWikiIngestionResult;
      log: RunLogItem[];
      credentialDiagnostics?: CredentialDiagnostic[];
    }
  | {
      status: "running";
      command: OpenWikiCommand;
      log: RunLogItem[];
      credentialDiagnostics?: CredentialDiagnostic[];
    }
  | {
      status: "success";
      result: OpenWikiRunResult;
      log: RunLogItem[];
      durationMs: number;
      credentialDiagnostics?: CredentialDiagnostic[];
    }
  | {
      status: "error";
      message: string;
      credentialDiagnostics?: CredentialDiagnostic[];
      errorDiagnostics?: ErrorDiagnostic[];
      authFix?: AuthFix;
    };

/**
 * Attaches the (opt-in, --debug) credential diagnostics to a live run: records
 * them on the ref so a later settle can carry them forward, and folds them into
 * the state only while it is still "running". A no-op on any other status so a
 * late diagnostics resolution cannot resurrect a settled run.
 */
export function updateRunningCredentialDiagnostics(
  state: RunState,
  credentialDiagnostics: CredentialDiagnostic[],
  credentialDiagnosticsRef: MutableRefObject<
    CredentialDiagnostic[] | undefined
  >,
): RunState {
  credentialDiagnosticsRef.current = credentialDiagnostics;

  return state.status === "running"
    ? {
        ...state,
        credentialDiagnostics,
      }
    : state;
}
