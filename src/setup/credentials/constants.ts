import {
  OPENWIKI_GOOGLE_CLIENT_ID_ENV_KEY,
  OPENWIKI_GOOGLE_CLIENT_SECRET_ENV_KEY,
  OPENWIKI_TAVILY_API_KEY_ENV_KEY,
  OPENWIKI_X_CLIENT_ID_ENV_KEY,
} from "../../config/constants.js";
import {
  openWikiConnectorsDisplayPath,
  openWikiEnvDisplayPath,
  openWikiLocalWikiDisplayPath,
} from "../../config/openwiki-home.js";
import type { OpenWikiRunMode } from "../../cli/commands.js";
import type { LangSmithRegion } from "../../connectors/sources/langsmith/setup.js";
import type {
  OnboardingMode,
  SourceSetupOption,
  SetupStepState,
} from "./types.js";

export const ONBOARDING_TEMPLATES = [
  {
    description:
      "Maintain a structured project wiki from a local Git repository, with code-oriented pages for architecture, workflows, source maps, and operational guidance.",
    id: "code",
    name: "Code",
    sourceIds: ["langsmith"],
    suggestedSources: ["Local Git repository"],
    suggestedGoal: "A code wiki for this repository.",
  },
  {
    description:
      "A personal assistant wiki that builds memory from email, notes, social/research sources, and web search so you can ask about projects, priorities, people, and recurring context.",
    id: "personal",
    name: "Personal",
    sourceIds: [
      "custom-mcp",
      "git-repo",
      "google",
      "notion",
      "web-search",
      "hackernews",
      "x",
    ],
    suggestedSources: [
      "Gmail",
      "Notion",
      "Custom MCP",
      "Web Search (Tavily)",
      "Hacker News",
      "X/Twitter",
    ],
    suggestedGoal:
      "Your personal brain. Track active projects, people, organizations, decisions, commitments, follow-ups, useful links, recurring themes, and fresh external signals. Organize the wiki so a personal assistant can answer what changed, what matters, what needs attention, and where supporting evidence came from. Be selective: summarize durable context and explicit action items, not every raw item.",
  },
] as const satisfies readonly OnboardingMode[];

export const RUN_MODE_OPTIONS = [
  {
    description: `Build a local personal brain wiki in ${openWikiLocalWikiDisplayPath} from configured sources.`,
    id: "personal",
    name: "Personal",
  },
  {
    description:
      "Build repository documentation in ./openwiki for this codebase.",
    id: "code",
    name: "Code",
  },
] as const satisfies readonly {
  description: string;
  id: OpenWikiRunMode;
  name: string;
}[];

export const LANGSMITH_REGION_OPTIONS = [
  {
    description: "US workspaces. The default.",
    host: "https://api.smith.langchain.com",
    id: "us",
    name: "US",
  },
  {
    description: "EU workspaces.",
    host: "https://eu.api.smith.langchain.com",
    id: "eu",
    name: "EU",
  },
  {
    description: "APAC workspaces.",
    host: "https://apac.api.smith.langchain.com",
    id: "apac",
    name: "APAC",
  },
] as const satisfies readonly {
  description: string;
  host: string;
  id: LangSmithRegion;
  name: string;
}[];

export const SOURCE_OPTIONS = [
  {
    displayName: "Local Git repository",
    examples: [
      "Track architecture notes from this repo.",
      "Summarize recent commits and changed files.",
    ],
    id: "git-repo",
    instructions: [
      "Choose the local repository directory OpenWiki should read.",
      "The default is the current working directory, and you can replace it with another path.",
      "You can add more repositories later in the connector config file.",
    ],
    secretInputs: [],
  },
  {
    displayName: "LangSmith traces",
    examples: ["support-bot-prod", "chat-agent"],
    id: "langsmith",
    instructions: [
      "Document how your agent runs, grounded in its LangSmith traces.",
      "List the projects to document; written to openwiki/.langsmith.json (committed).",
    ],
    // No secret input: the LangSmith key is captured by the earlier `langsmith`
    // spine step (and provided as a CI secret), and used at pull time, not here.
    secretInputs: [],
  },
  {
    authProvider: "notion",
    displayName: "Notion",
    examples: [
      "Ingest product specs, meeting notes, and research pages.",
      "Prioritize pages related to Applied AI and customer feedback.",
    ],
    id: "notion",
    instructions: [
      "OpenWiki uses Notion's hosted MCP OAuth flow.",
      "No client ID, client secret, or pasted Notion token is required.",
      "Approve access in the browser window when it opens.",
    ],
    secretInputs: [],
  },
  {
    displayName: "Custom MCP",
    examples: [
      "Point OpenWiki at a Linear, Jira, or internal MCP server.",
      "Ingest read-only tools from a self-hosted knowledge MCP.",
    ],
    id: "custom-mcp",
    instructions: [
      `Edit ${openWikiConnectorsDisplayPath}/custom-mcp/config.json after setup.`,
      'Set "enabled": true and an HTTP or stdio "transport".',
      `Put secrets only in ${openWikiEnvDisplayPath}; reference them as \${ENV_NAME} in headers/env.`,
      "Prefer allowedTools and MCP readOnlyHint. Optionally set readOnlyOperations for a fixed pull recipe.",
      "Do not allowlist mutating tools. This is a built-in generic MCP source, not a plugin loader.",
    ],
    secretInputs: [],
  },
  {
    authProvider: "gmail",
    displayName: "Gmail",
    examples: [
      "Capture important project email threads from the last 24 hours.",
      "Look for vendor updates, customer feedback, and action items.",
    ],
    id: "google",
    instructions: [
      "Create OAuth credentials in Google Cloud for a desktop or web app.",
      "Enable the Gmail API for the Google Cloud project.",
      "Add http://127.0.0.1:53682/callback as an authorized redirect URI.",
      "Paste the client ID and client secret below.",
    ],
    secretInputs: [
      {
        envKey: OPENWIKI_GOOGLE_CLIENT_ID_ENV_KEY,
        label: "Google OAuth client ID",
      },
      {
        envKey: OPENWIKI_GOOGLE_CLIENT_SECRET_ENV_KEY,
        label: "Google OAuth client secret",
        secret: true,
      },
    ],
  },
  {
    displayName: "Web Search (Tavily)",
    examples: [
      "Track a company, product category, or technical topic.",
      "Find launch posts, docs, pricing pages, and recent articles.",
    ],
    id: "web-search",
    instructions: [
      "Create a Tavily account and API key.",
      "Paste the Tavily API key below.",
      "Describe the topics, companies, or pages OpenWiki should search for on the next screen.",
    ],
    secretInputs: [
      {
        envKey: OPENWIKI_TAVILY_API_KEY_ENV_KEY,
        label: "Tavily API key",
        secret: true,
      },
    ],
  },
  {
    displayName: "Hacker News",
    examples: [
      "Monitor threads about AI agents, evals, infrastructure, and startups.",
      "Capture notable discussions and links related to my research topics.",
    ],
    id: "hackernews",
    instructions: [
      "No account setup is required for Hacker News.",
      "OpenWiki uses public Hacker News feed and search APIs.",
      "Describe the topics, keywords, users, or story types OpenWiki should watch on the next screen.",
    ],
    secretInputs: [],
  },
  {
    authProvider: "x",
    displayName: "X / Twitter",
    examples: [
      "Track my home timeline, bookmarks, and key lists.",
      "Summarize tweets from AI researchers and product announcements.",
    ],
    id: "x",
    instructions: [
      "Create an X OAuth 2.0 app.",
      "Use a native app or public client when possible.",
      "Add http://127.0.0.1:53682/callback as a callback URI.",
      "Paste the OAuth client ID below.",
    ],
    secretInputs: [
      {
        envKey: OPENWIKI_X_CLIENT_ID_ENV_KEY,
        label: "X OAuth client ID",
      },
    ],
  },
] as const satisfies readonly SourceSetupOption[];

export const CRON_MODE_OPTIONS = [
  "Use suggested schedule",
  "Enter custom cron",
] as const;
export const POWER_MODE_OPTIONS = [
  "Set up Mac wake/sleep window",
  "Skip power setup",
] as const;
export const CRON_FIELD_LABELS = ["minute", "hour", "day", "month", "weekday"];
export const SOURCE_CONTINUE_OPTIONS = [
  "Go back to connections",
  "Continue without all sources",
] as const;
export const FINAL_OPTIONS = ["Run ingestion now", "Run later"] as const;
export const CODE_REPO_OPTIONS = ["Confirm and continue", "Edit path"] as const;

/**
 * Progress glyph per status: a check for done, an arrow for the active row, a
 * hollow circle for not-started (and optional). Single cell wide so every row's
 * label column lines up without padding the marker.
 */
export const STEP_GLYPH: Record<SetupStepState, string> = {
  done: "✓",
  current: "❯",
  optional: "○",
  pending: "○",
};

/** Color per status. Optionality is conveyed by the detail text, not the glyph. */
export const STEP_COLOR: Record<SetupStepState, string> = {
  done: "green",
  current: "cyan",
  optional: "gray",
  pending: "gray",
};
