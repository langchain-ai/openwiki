/**
 * Runs the OpenWiki agent with one narrow, single-purpose task instead of the
 * general ingestion synthesis prompt. Shared by graduation.ts and
 * restructure.ts, which each only need to supply the task-specific message.
 */

import { createOpenWikiThreadId, runOpenWikiAgent } from "../agent/index.js";
import { openWikiLocalWikiDir } from "../config/openwiki-home.js";
import {
  withRunTelemetry,
  type RunTelemetryContext,
} from "../telemetry/index.js";
import type { OpenWikiRunOptions, OpenWikiRunResult } from "../agent/types.js";

export async function runScopedWikiTask(
  userMessage: string,
  wikiDir: string = openWikiLocalWikiDir,
): Promise<OpenWikiRunResult> {
  const runOptions: OpenWikiRunOptions = {
    isFollowup: false,
    onEvent: undefined,
    outputMode: "local-wiki",
    threadId: createOpenWikiThreadId(wikiDir),
    userMessage,
  };
  const telemetryContext: RunTelemetryContext = {};
  return withRunTelemetry("update", runOptions, telemetryContext, () =>
    runOpenWikiAgent("update", wikiDir, runOptions, telemetryContext),
  );
}
