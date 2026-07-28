import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  commandEmitsTelemetry,
  getHelpText,
  parseCommand,
  shouldRunNonInteractively,
} from "../../src/cli/commands.ts";

// parseCommand's --dry-run gate consults isDevelopmentMode(), which reads
// NODE_ENV / OPENWIKI_DEV. Pin both to a non-development state per test and
// restore afterward.
const originalNodeEnv = process.env.NODE_ENV;
const originalDevFlag = process.env.OPENWIKI_DEV;
const originalDebug = process.env.OPENWIKI_DEBUG;

beforeEach(() => {
  delete process.env.NODE_ENV;
  delete process.env.OPENWIKI_DEV;
  // parseCommand sets OPENWIKI_DEBUG as a side effect of --debug; start clean.
  delete process.env.OPENWIKI_DEBUG;
});

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDevFlag === undefined) delete process.env.OPENWIKI_DEV;
  else process.env.OPENWIKI_DEV = originalDevFlag;
  if (originalDebug === undefined) delete process.env.OPENWIKI_DEBUG;
  else process.env.OPENWIKI_DEBUG = originalDebug;
});

describe("parseCommand — --debug", () => {
  test("--debug sets OPENWIKI_DEBUG and still parses the run", () => {
    expect(process.env.OPENWIKI_DEBUG).toBeUndefined();

    const result = parseCommand(["--debug", "--init"]);

    expect(process.env.OPENWIKI_DEBUG).toBe("1");
    expect(result).toMatchObject({ kind: "run", command: "init" });
  });

  test("without --debug, OPENWIKI_DEBUG stays unset", () => {
    parseCommand(["--init"]);

    expect(process.env.OPENWIKI_DEBUG).toBeUndefined();
  });
});

describe("parseCommand — help", () => {
  test("--help and -h return a help command", () => {
    expect(parseCommand(["--help"])).toEqual({ kind: "help", exitCode: 0 });
    expect(parseCommand(["-h"])).toEqual({ kind: "help", exitCode: 0 });
  });

  test("--help anywhere in argv wins", () => {
    expect(parseCommand(["--init", "--help"]).kind).toBe("help");
  });

  test("help documents scheduled-only ingest usage", () => {
    const helpText = getHelpText();

    expect(helpText).toContain(
      "openwiki ingest <source|source-instance|all> [--scheduled] [--print] [--modelId <id>]",
    );
    expect(helpText).toContain("--scheduled");
    expect(helpText).toContain("scheduled-only ingestion");
    expect(helpText).toContain("openwiki ingest all --scheduled --print");
  });

  test("help documents the output language option", () => {
    expect(getHelpText()).toContain("-l, --language <locale>");
  });
});

describe("parseCommand — chat default", () => {
  test("no args is an interactive chat that should not auto-start", () => {
    const result = parseCommand([]);

    expect(result).toMatchObject({
      kind: "run",
      command: "chat",
      mode: "code",
      modeSource: "default",
      shouldStart: false,
      userMessage: null,
      print: false,
      dryRun: false,
      modelId: null,
    });
  });

  test("explicit mode without a message opens chat without auto-starting", () => {
    expect(parseCommand(["personal"])).toMatchObject({
      kind: "run",
      command: "chat",
      mode: "personal",
      modeSource: "positional",
      shouldStart: false,
    });
    expect(parseCommand(["code"])).toMatchObject({
      kind: "run",
      command: "chat",
      mode: "code",
      modeSource: "positional",
      shouldStart: false,
    });
    expect(parseCommand(["--mode", "personal"])).toMatchObject({
      kind: "run",
      command: "chat",
      mode: "personal",
      modeSource: "option",
      shouldStart: false,
    });
  });

  test("a positional message becomes the user message and starts", () => {
    const result = parseCommand(["Document", "the", "API"]);

    expect(result).toMatchObject({
      kind: "run",
      command: "chat",
      mode: "code",
      modeSource: "default",
      userMessage: "Document the API",
      shouldStart: true,
    });
  });
});

describe("parseCommand — mode after flags", () => {
  test("a mode word after a flag is still recognized as the mode", () => {
    expect(parseCommand(["--print", "code", "--update"])).toMatchObject({
      kind: "run",
      command: "update",
      mode: "code",
      modeSource: "positional",
      userMessage: null,
    });
    expect(parseCommand(["--update", "personal"])).toMatchObject({
      kind: "run",
      command: "update",
      mode: "personal",
      modeSource: "positional",
      userMessage: null,
    });
  });

  test("mode after a flag satisfies the --init mode requirement", () => {
    expect(parseCommand(["--print", "code", "--init"])).toMatchObject({
      kind: "run",
      command: "init",
      mode: "code",
    });
  });

  test("a mode word is only promoted once; later ones join the message", () => {
    expect(
      parseCommand(["--update", "personal", "code", "docs"]),
    ).toMatchObject({
      kind: "run",
      mode: "personal",
      userMessage: "code docs",
    });
  });

  test("a mode word after an explicit --mode stays part of the message", () => {
    expect(parseCommand(["--mode", "code", "personal", "notes"])).toMatchObject(
      {
        kind: "run",
        mode: "code",
        modeSource: "option",
        userMessage: "personal notes",
      },
    );
  });

  test("a mode word after a message word stays part of the message", () => {
    expect(parseCommand(["document", "personal", "paths"])).toMatchObject({
      kind: "run",
      mode: "code",
      modeSource: "default",
      userMessage: "document personal paths",
    });
  });
});

describe("parseCommand — init/update", () => {
  test("--language passes the selected locale to an init run", () => {
    expect(parseCommand(["--init", "--language", "zh-CN"])).toMatchObject({
      kind: "run",
      command: "init",
      language: "zh-CN",
    });
  });

  test("-l passes the selected locale to an update run", () => {
    expect(parseCommand(["--update", "-l", "zh-CN"])).toMatchObject({
      kind: "run",
      command: "update",
      language: "zh-CN",
    });
  });

  test("language is unset when no language option is supplied", () => {
    expect(parseCommand(["--init"])).toMatchObject({
      kind: "run",
      language: null,
    });
  });

  test("--language requires a locale", () => {
    expect(parseCommand(["--language", "--init"])).toMatchObject({
      kind: "error",
      message: "--language requires a locale.",
    });
  });

  test("--language canonicalizes the locale and sets no warning", () => {
    expect(parseCommand(["--init", "--language", "PT-br"])).toMatchObject({
      kind: "run",
      language: "pt-BR",
      languageWarning: null,
    });
  });

  test("an unrecognized --language is dropped and warned", () => {
    const result = parseCommand(["--init", "--language", "fake-language"]);

    expect(result).toMatchObject({ kind: "run", language: null });
    if (result.kind === "run") {
      expect(result.languageWarning).toContain("fake-language");
    }
  });

  test("personal --init selects the init command and starts", () => {
    expect(parseCommand(["personal", "--init"])).toMatchObject({
      kind: "run",
      command: "init",
      mode: "personal",
      shouldStart: true,
    });
  });

  test("bare --init defaults to code mode", () => {
    expect(parseCommand(["--init"])).toMatchObject({
      kind: "run",
      command: "init",
      mode: "code",
      modeSource: "default",
      shouldStart: true,
    });
  });

  test("bare --update defaults to code mode", () => {
    expect(parseCommand(["--update"])).toMatchObject({
      kind: "run",
      command: "update",
      mode: "code",
      modeSource: "default",
      shouldStart: true,
    });
  });

  test("explicit personal mode overrides the one-shot default", () => {
    expect(parseCommand(["personal", "--init"])).toMatchObject({
      kind: "run",
      command: "init",
      mode: "personal",
      modeSource: "positional",
    });
    expect(parseCommand(["--update", "--mode", "personal"])).toMatchObject({
      kind: "run",
      command: "update",
      mode: "personal",
      modeSource: "option",
    });
  });

  test("--init and --update together is an error", () => {
    const result = parseCommand(["--init", "--update"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/cannot be used together/u);
    }
  });

  test("repeating the same command flag is allowed", () => {
    expect(parseCommand(["personal", "--init", "--init"]).kind).toBe("run");
  });
});

describe("parseCommand — print", () => {
  test("--print with a message runs and prints", () => {
    expect(parseCommand(["-p", "hello"])).toMatchObject({
      kind: "run",
      print: true,
      userMessage: "hello",
      shouldStart: true,
    });
  });

  test("--print with explicit-mode --init is valid", () => {
    expect(parseCommand(["personal", "--print", "--init"])).toMatchObject({
      kind: "run",
      print: true,
      command: "init",
    });
  });

  test("--print with nothing to run is an error", () => {
    const result = parseCommand(["-p"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/requires a message/u);
    }
  });
});

describe("parseCommand — --modelId", () => {
  test("space-separated valid model id", () => {
    expect(parseCommand(["--modelId", "claude-opus-4-8"])).toMatchObject({
      kind: "run",
      modelId: "claude-opus-4-8",
    });
  });

  test("--model-id alias works", () => {
    expect(parseCommand(["--model-id", "gpt-5.5"])).toMatchObject({
      modelId: "gpt-5.5",
    });
  });

  test("equals form: --modelId=<id>", () => {
    expect(parseCommand(["--modelId=z-ai/glm-5.2"])).toMatchObject({
      modelId: "z-ai/glm-5.2",
    });
  });

  test("@-versioned Vertex AI model id is accepted", () => {
    expect(
      parseCommand(["--modelId", "claude-haiku-4-5@20251001"]),
    ).toMatchObject({
      kind: "run",
      modelId: "claude-haiku-4-5@20251001",
    });
  });

  test("missing value is an error", () => {
    const result = parseCommand(["--modelId"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/requires a model ID/u);
    }
  });

  test("a following flag is treated as a missing value", () => {
    const result = parseCommand(["--modelId", "--init"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/requires a model ID/u);
    }
  });

  test("invalid model id (contains ://) is an error", () => {
    const result = parseCommand(["--modelId", "http://evil"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/Invalid model ID/u);
    }
  });

  test("invalid model id via equals form is an error", () => {
    expect(parseCommand(["--modelId="]).kind).toBe("error");
  });
});

describe("parseCommand — ingest", () => {
  test("scheduled launchd ingestion parses as scheduled-only print mode", () => {
    expect(
      parseCommand(["ingest", "all", "--scheduled", "--print"]),
    ).toMatchObject({
      kind: "ingest",
      target: "all",
      scheduledOnly: true,
      print: true,
      modelId: null,
    });
  });

  test("ingest defaults to non-scheduled mode", () => {
    expect(parseCommand(["ingest", "web-search"])).toMatchObject({
      kind: "ingest",
      target: "web-search",
      scheduledOnly: false,
      print: false,
    });
  });

  test("invalid ingest targets mention the scheduled flag in usage", () => {
    const result = parseCommand(["ingest", "@bad"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("[--scheduled]");
    }
  });
});

describe("parseCommand — unknown options and dry-run gating", () => {
  test("an unknown --flag is an error", () => {
    const result = parseCommand(["--nope"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/Unknown option/u);
    }
  });

  test("--dry-run is rejected outside development mode", () => {
    const result = parseCommand(["--dry-run"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/Unknown option/u);
    }
  });

  test("--dry-run is accepted in development mode", () => {
    process.env.OPENWIKI_DEV = "1";

    expect(parseCommand(["personal", "--dry-run", "--init"])).toMatchObject({
      kind: "run",
      dryRun: true,
      command: "init",
    });
  });
});

describe("parseCommand — auth", () => {
  test("auth tools rejects --force", () => {
    const result = parseCommand(["auth", "tools", "notion", "--force"]);

    expect(result).toEqual({
      kind: "error",
      exitCode: 1,
      message: "Unknown option for auth: --force",
    });
  });

  test("legacy auth configure shorthand accepts --force", () => {
    expect(parseCommand(["auth", "notion", "--force"])).toMatchObject({
      kind: "auth",
      action: "oauth",
      provider: "notion",
      force: true,
    });
  });

  test("auth configure accepts --force", () => {
    expect(
      parseCommand(["auth", "configure", "notion", "--force"]),
    ).toMatchObject({
      kind: "auth",
      action: "configure",
      provider: "notion",
      force: true,
    });
  });
});

describe("shouldRunNonInteractively", () => {
  test("--init and --update without --print bypass the UI when stdin is not a TTY", () => {
    expect(
      shouldRunNonInteractively(parseCommand(["personal", "--init"]), false),
    ).toBe(true);
    expect(shouldRunNonInteractively(parseCommand(["--update"]), false)).toBe(
      true,
    );
  });

  test("a one-shot chat message bypasses the UI when stdin is not a TTY", () => {
    expect(
      shouldRunNonInteractively(parseCommand(["Document the API"]), false),
    ).toBe(true);
  });

  test("--init on a TTY keeps the interactive UI", () => {
    expect(
      shouldRunNonInteractively(parseCommand(["personal", "--init"]), true),
    ).toBe(false);
  });

  test("--print bypasses the UI regardless of TTY", () => {
    expect(
      shouldRunNonInteractively(
        parseCommand(["personal", "--init", "--print"]),
        true,
      ),
    ).toBe(true);
    expect(
      shouldRunNonInteractively(
        parseCommand(["personal", "--init", "--print"]),
        false,
      ),
    ).toBe(true);
  });

  test("interactive chat without a message still uses the UI path", () => {
    expect(shouldRunNonInteractively(parseCommand([]), false)).toBe(false);
    expect(shouldRunNonInteractively(parseCommand([]), true)).toBe(false);
  });

  test("dry-run, help, and error commands never run non-interactively", () => {
    process.env.OPENWIKI_DEV = "1";
    expect(
      shouldRunNonInteractively(parseCommand(["--dry-run", "--init"]), false),
    ).toBe(false);
    expect(shouldRunNonInteractively(parseCommand(["--help"]), false)).toBe(
      false,
    );
    expect(shouldRunNonInteractively(parseCommand(["--nope"]), false)).toBe(
      false,
    );
  });
});

describe("parseCommand — cron", () => {
  test("cron list returns a list command", () => {
    expect(parseCommand(["cron", "list"])).toMatchObject({
      kind: "cron",
      action: "list",
      target: null,
    });
  });

  test("cron pause with a source instance id is rejected", () => {
    const result = parseCommand(["cron", "pause", "web-search-1"]);
    expect(result.kind).toBe("error");
  });

  test("cron pause with a source id is rejected", () => {
    const result = parseCommand(["cron", "pause", "web-search"]);
    expect(result.kind).toBe("error");
  });

  test("cron resume with a source instance id is rejected", () => {
    const result = parseCommand(["cron", "resume", "web-search-1"]);
    expect(result.kind).toBe("error");
  });

  test("cron delete with a source instance id is rejected", () => {
    const result = parseCommand(["cron", "delete", "web-search-1"]);
    expect(result.kind).toBe("error");
  });

  test("cron pause with 'all' is accepted", () => {
    expect(parseCommand(["cron", "pause", "all"])).toMatchObject({
      kind: "cron",
      action: "pause",
    });
  });

  test("cron pause with no target is an error", () => {
    const result = parseCommand(["cron", "pause"]);
    expect(result.kind).toBe("error");
  });

  test("cron pause with extra arguments is an error", () => {
    const result = parseCommand(["cron", "pause", "all", "extra"]);
    expect(result.kind).toBe("error");
  });

  test("an unknown cron subcommand falls through to usage guidance", () => {
    const result = parseCommand(["cron", "bogus"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/list \| pause all \| resume all/u);
    }
  });

  test("cron with no subcommand is an error", () => {
    expect(parseCommand(["cron"]).kind).toBe("error");
  });

  test("cron list with an extra argument is rejected", () => {
    // `list` only matches when it stands alone; a trailing token drops it into
    // the usage-error branch rather than silently ignoring the extra input.
    expect(parseCommand(["cron", "list", "extra"]).kind).toBe("error");
  });
});

describe("parseCommand — ngrok", () => {
  test("bare ngrok start uses the default OAuth callback port and no url", () => {
    expect(parseCommand(["ngrok", "start"])).toEqual({
      kind: "ngrok",
      action: "start",
      exitCode: 0,
      port: 53682,
      url: null,
    });
  });

  test("a positional url is captured as the fixed tunnel url", () => {
    expect(
      parseCommand(["ngrok", "start", "https://openwiki.ngrok.app"]),
    ).toMatchObject({
      kind: "ngrok",
      url: "https://openwiki.ngrok.app",
      port: 53682,
    });
  });

  test("--port accepts a space-separated value", () => {
    expect(parseCommand(["ngrok", "start", "--port", "8080"])).toMatchObject({
      kind: "ngrok",
      port: 8080,
    });
  });

  test("--port=<n> equals form is accepted", () => {
    expect(parseCommand(["ngrok", "start", "--port=9000"])).toMatchObject({
      kind: "ngrok",
      port: 9000,
    });
  });

  test("url and --port can be combined in either order", () => {
    expect(
      parseCommand(["ngrok", "start", "https://x.ngrok.app", "--port", "8080"]),
    ).toMatchObject({
      kind: "ngrok",
      url: "https://x.ngrok.app",
      port: 8080,
    });
  });

  test("ngrok without the start subcommand is an error", () => {
    const result = parseCommand(["ngrok"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/ngrok start/u);
    }
  });

  test("--port with no value is an error", () => {
    const result = parseCommand(["ngrok", "start", "--port"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/--port requires a value/u);
    }
  });

  test("a non-integer port is rejected by the range check", () => {
    const result = parseCommand(["ngrok", "start", "--port", "abc"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/between 1024 and 65535/u);
    }
  });

  test("a privileged port below 1024 is rejected", () => {
    expect(parseCommand(["ngrok", "start", "--port", "80"]).kind).toBe("error");
  });

  test("a port above 65535 is rejected", () => {
    expect(parseCommand(["ngrok", "start", "--port", "70000"]).kind).toBe(
      "error",
    );
  });

  test("a second positional argument is an unknown option", () => {
    // The url slot only fills once; a second bare token is not silently
    // dropped but surfaced as an unknown option.
    const result = parseCommand(["ngrok", "start", "https://a", "https://b"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/Unknown option for ngrok/u);
    }
  });

  test("an unknown flag is reported", () => {
    const result = parseCommand(["ngrok", "start", "--nope"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/Unknown option for ngrok/u);
    }
  });
});

describe("parseCommand — auth listing and validation", () => {
  test("bare auth lists providers via the oauth-list branch", () => {
    expect(parseCommand(["auth"])).toEqual({
      kind: "auth",
      action: "list",
      exitCode: 0,
      force: false,
      provider: null,
    });
  });

  test("explicit auth list also returns the list command", () => {
    expect(parseCommand(["auth", "list"])).toMatchObject({
      kind: "auth",
      action: "list",
      provider: null,
    });
  });

  test("an unrecognized provider is rejected", () => {
    const result = parseCommand(["auth", "bogus-provider"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/Unknown auth provider: bogus-provider/u);
    }
  });

  test("auth configure without a provider prints its usage", () => {
    const result = parseCommand(["auth", "configure"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/auth configure <provider>/u);
    }
  });

  test("auth tools without a provider prints its usage", () => {
    const result = parseCommand(["auth", "tools"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/auth tools <provider>/u);
    }
  });

  test("auth tools with a valid provider parses and never carries force", () => {
    expect(parseCommand(["auth", "tools", "notion"])).toEqual({
      kind: "auth",
      action: "tools",
      exitCode: 0,
      force: false,
      provider: "notion",
    });
  });
});

describe("parseCommand — ingest --modelId", () => {
  test("space-separated valid model id is normalized onto the ingest run", () => {
    expect(
      parseCommand(["ingest", "all", "--modelId", "claude-opus-4-8"]),
    ).toMatchObject({
      kind: "ingest",
      target: "all",
      modelId: "claude-opus-4-8",
    });
  });

  test("--model-id equals form is accepted for ingest", () => {
    expect(parseCommand(["ingest", "all", "--model-id=gpt-5.5"])).toMatchObject(
      {
        kind: "ingest",
        modelId: "gpt-5.5",
      },
    );
  });

  test("ingest --modelId with no value is an error", () => {
    const result = parseCommand(["ingest", "all", "--modelId"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/requires a model ID/u);
    }
  });

  test("ingest --modelId with an invalid id is rejected, not passed through", () => {
    const result = parseCommand(["ingest", "all", "--modelId", "http://evil"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/Invalid model ID/u);
    }
  });

  test("ingest --modelId= equals form with an invalid id is rejected", () => {
    expect(parseCommand(["ingest", "all", "--modelId=http://evil"]).kind).toBe(
      "error",
    );
  });

  test("an unknown ingest flag is reported", () => {
    const result = parseCommand(["ingest", "all", "--nope"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/Unknown option for ingest/u);
    }
  });
});

describe("parseCommand — --mode option forms and conflicts", () => {
  test("--mode with no value is an error", () => {
    const result = parseCommand(["--mode"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/--mode requires personal or code/u);
    }
  });

  test("--mode followed by a flag is treated as a missing value", () => {
    expect(parseCommand(["--mode", "--init"]).kind).toBe("error");
  });

  test("an invalid --mode value is rejected", () => {
    const result = parseCommand(["--mode", "hybrid"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/Invalid mode: hybrid/u);
    }
  });

  test("--mode=<value> equals form selects the mode", () => {
    expect(parseCommand(["--mode=personal", "--init"])).toMatchObject({
      kind: "run",
      mode: "personal",
      modeSource: "option",
      command: "init",
    });
  });

  test("an invalid --mode= equals value is rejected", () => {
    expect(parseCommand(["--mode=hybrid"]).kind).toBe("error");
  });

  test("--mode that contradicts a positional mode is a conflict", () => {
    // `code` fixes the mode positionally; a later --mode personal cannot
    // silently override it, so the parser reports the conflict.
    const result = parseCommand(["code", "--mode", "personal"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/Conflicting modes: code and personal/u);
    }
  });

  test("--mode= that contradicts a positional mode is a conflict", () => {
    expect(parseCommand(["code", "--mode=personal"]).kind).toBe("error");
  });

  test("--mode restating the same mode is not a conflict", () => {
    expect(parseCommand(["code", "--mode", "code", "--init"])).toMatchObject({
      kind: "run",
      mode: "code",
      command: "init",
    });
  });
});

describe("parseCommand — --telemetry-file", () => {
  test("space-separated path is captured alongside the run", () => {
    expect(
      parseCommand(["--print", "--telemetry-file", "/tmp/payload.json", "hi"]),
    ).toMatchObject({
      kind: "run",
      telemetryFile: "/tmp/payload.json",
      userMessage: "hi",
      print: true,
    });
  });

  test("--telemetry-file= equals form is captured", () => {
    expect(
      parseCommand(["--init", "--telemetry-file=/tmp/out.json"]),
    ).toMatchObject({
      kind: "run",
      command: "init",
      telemetryFile: "/tmp/out.json",
    });
  });

  test("--telemetry-file with no path is an error", () => {
    const result = parseCommand(["--telemetry-file"]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/--telemetry-file requires a path/u);
    }
  });

  test("--telemetry-file followed by a flag is treated as a missing path", () => {
    expect(parseCommand(["--telemetry-file", "--init"]).kind).toBe("error");
  });

  test("an empty --telemetry-file= value is an error", () => {
    const result = parseCommand(["--telemetry-file="]);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/--telemetry-file requires a path/u);
    }
  });

  test("telemetry file defaults to null when the option is absent", () => {
    expect(parseCommand(["--init"])).toMatchObject({ telemetryFile: null });
  });
});

describe("commandEmitsTelemetry", () => {
  test("init and update runs emit the single telemetry event", () => {
    expect(commandEmitsTelemetry(parseCommand(["--init"]))).toBe(true);
    expect(commandEmitsTelemetry(parseCommand(["--update"]))).toBe(true);
  });

  test("a plain chat run emits nothing", () => {
    expect(commandEmitsTelemetry(parseCommand(["hello there"]))).toBe(false);
  });

  test("a dry-run init records nothing because the agent never runs", () => {
    process.env.OPENWIKI_DEV = "1";

    expect(commandEmitsTelemetry(parseCommand(["--dry-run", "--init"]))).toBe(
      false,
    );
  });

  test("ingest, auth, help, and error commands never emit telemetry", () => {
    expect(commandEmitsTelemetry(parseCommand(["ingest", "all"]))).toBe(false);
    expect(commandEmitsTelemetry(parseCommand(["auth", "notion"]))).toBe(false);
    expect(commandEmitsTelemetry(parseCommand(["--help"]))).toBe(false);
    expect(commandEmitsTelemetry(parseCommand(["--nope"]))).toBe(false);
  });
});

describe("getHelpText — development sections", () => {
  test("dev-only sections are hidden outside development mode", () => {
    const helpText = getHelpText();

    expect(helpText).not.toContain("Development Options");
    expect(helpText).not.toContain("--dry-run");
  });

  test("development mode reveals the --dry-run option and example", () => {
    process.env.OPENWIKI_DEV = "1";
    const helpText = getHelpText();

    expect(helpText).toContain("Development Options");
    expect(helpText).toContain("--dry-run");
    expect(helpText).toContain("openwiki --dry-run");
  });
});
