import type { OpenWikiProvider } from "../../constants.js";
import type {
  OpenWikiCommand,
  OpenWikiOutputMode,
  OpenWikiRunEvent,
} from "../types.js";

export type CliRunSpec = {
  command: OpenWikiCommand;
  cwd: string;
  modelId: string;
  outputMode: OpenWikiOutputMode;
  resumeSessionId: string | null;
  systemPrompt: string;
  userPrompt: string;
};

export type CliParsedEvent =
  | { kind: "event"; event: OpenWikiRunEvent }
  | { kind: "session"; sessionId: string }
  | { kind: "result"; isError: boolean; message: string };

export type CliEngineAdapter = {
  /** Executable name looked up on PATH, e.g. "claude". */
  cliCommand: string;
  engine: OpenWikiProvider;
  buildArgs(spec: CliRunSpec): string[];
  /** Parse one stdout line into zero or more parsed events. Must not throw. */
  parseLine(line: string): CliParsedEvent[];
};
