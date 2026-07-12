import {
  configureAuthProvider,
  listAuthProviderTools,
  shouldDiscoverToolsAfterAuth,
} from "../../auth/configure.js";
import { formatAuthProviderList, runOAuthAuth } from "../../auth/oauth.js";
import type { CliCommand } from "../../commands.js";
import { getErrorMessage } from "../../diagnostics.js";

/**
 * Runs the `openwiki auth` command. Dispatches on the sub-action: `list` prints
 * the known providers; `configure` writes a provider config; `tools` discovers
 * MCP tools; the default runs the OAuth login, then configures and (where
 * supported) discovers tools for the provider. Sets the process exit code.
 */
export async function runAuthCommand(
  command: Extract<CliCommand, { kind: "auth" }>,
): Promise<void> {
  try {
    if (command.action === "list") {
      process.stdout.write(`${formatAuthProviderList()}\n`);
      process.exitCode = 0;
      return;
    }

    if (command.provider === null) {
      throw new Error("Auth provider is required.");
    }

    if (command.action === "configure") {
      const result = await configureAuthProvider(command.provider, {
        force: command.force,
      });
      process.stdout.write(
        `${result.status === "exists" ? "Config already exists" : `Config ${result.status}`}: ${result.configPath}\n`,
      );
      for (const nextStep of result.nextSteps) {
        process.stdout.write(`- ${nextStep}\n`);
      }
      process.exitCode = 0;
      return;
    }

    if (command.action === "tools") {
      const result = await listAuthProviderTools(command.provider);
      process.stdout.write(
        `Tools for ${result.provider} (${result.configPath})\n`,
      );
      process.stdout.write(`Wrote discovery: ${result.rawFile}\n`);
      process.stdout.write(`${JSON.stringify(result.tools, null, 2)}\n`);
      process.exitCode = 0;
      return;
    }

    const result = await runOAuthAuth(command.provider);
    process.stdout.write(
      `Saved ${result.provider} auth values: ${result.savedEnvKeys.join(", ")}\n`,
    );
    const configureResult = await configureAuthProvider(command.provider, {
      force: command.force,
    });
    process.stdout.write(
      `${configureResult.status === "exists" ? "Config already exists" : `Config ${configureResult.status}`}: ${configureResult.configPath}\n`,
    );
    for (const nextStep of configureResult.nextSteps) {
      process.stdout.write(`- ${nextStep}\n`);
    }

    if (shouldDiscoverToolsAfterAuth(command.provider)) {
      try {
        const toolsResult = await listAuthProviderTools(command.provider);
        process.stdout.write(
          `Discovered ${toolsResult.tools.length} MCP tool(s); wrote ${toolsResult.rawFile}\n`,
        );
        const toolNames = toolsResult.tools
          .map((tool) => tool.name)
          .slice(0, 20);
        if (toolNames.length > 0) {
          process.stdout.write(`Tools: ${toolNames.join(", ")}\n`);
        }
      } catch (error) {
        process.stdout.write(
          `MCP tool discovery skipped: ${getErrorMessage(error)}\n`,
        );
      }
    }
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
