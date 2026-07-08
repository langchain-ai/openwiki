import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { saveOpenWikiEnv } from "./env.js";

export type ConfigSetupResult = {
  saved: boolean;
};

type ConfigSetupProps = {
  onComplete: (result: ConfigSetupResult) => void;
  onError: (message: string) => void;
};

type ConfigStep = "menu" | "toggle-langsmith" | "api-key" | "trace-name";

type MenuOption = {
  label: string;
  id: "toggle" | "api-key" | "project";
};

const menuOptions: MenuOption[] = [
  { label: "Toggle LangSmith", id: "toggle" },
  { label: "Set API Key", id: "api-key" },
  { label: "Set Project Name", id: "project" },
];

export function ConfigSetup({
  onComplete,
  onError,
}: ConfigSetupProps) {
  const [step, setStep] = useState<ConfigStep>("menu");
  const [menuIndex, setMenuIndex] = useState(0);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const isLangSmithEnabled =
    process.env.LANGSMITH_API_KEY && process.env.LANGCHAIN_TRACING_V2 === "true";

  useInput((inputValue, key) => {
    if (isSaving) {
      return;
    }

    if (step === "menu") {
      if (key.upArrow) {
        setMenuIndex((i) => (i === 0 ? menuOptions.length - 1 : i - 1));
        setError(null);
        return;
      }

      if (key.downArrow) {
        setMenuIndex((i) => (i === menuOptions.length - 1 ? 0 : i + 1));
        setError(null);
        return;
      }

      if (key.return) {
        const option = menuOptions[menuIndex];
        if (option.id === "toggle") {
          setStep("toggle-langsmith");
          setError(null);
        } else if (option.id === "api-key") {
          setStep("api-key");
          setInput("");
          setError(null);
        } else if (option.id === "project") {
          setStep("trace-name");
          setInput("");
          setError(null);
        }
        return;
      }

      if (key.escape) {
        onComplete({ saved: false });
        return;
      }
    }

    if (step === "toggle-langsmith") {
      if (inputValue === "y") {
        setInput("");
        handleToggleLangSmith(true);
        return;
      }

      if (inputValue === "n") {
        setInput("");
        handleToggleLangSmith(false);
        return;
      }

      if (key.escape) {
        setStep("menu");
        setInput("");
        setError(null);
        return;
      }
    }

    if (step === "api-key") {
      if (key.return) {
        const trimmedInput = input.trim();

        if (trimmedInput.length === 0) {
          setError("LangSmith API key is required.");
          return;
        }

        handleSaveApiKey(trimmedInput);
        return;
      }

      if (key.escape) {
        setStep("menu");
        setInput("");
        setError(null);
        return;
      }

      setInput(inputValue === "" ? input.slice(0, -1) : input + inputValue);
    }

    if (step === "trace-name") {
      if (key.return) {
        const trimmedInput = input.trim();

        if (trimmedInput.length === 0) {
          setError("Project name is required.");
          return;
        }

        handleSaveTraceName(trimmedInput);
        return;
      }

      if (key.escape) {
        setStep("menu");
        setInput("");
        setError(null);
        return;
      }

      setInput(inputValue === "" ? input.slice(0, -1) : input + inputValue);
    }
  });

  async function handleToggleLangSmith(enable: boolean) {
    setIsSaving(true);

    try {
      if (enable && !process.env.LANGSMITH_API_KEY) {
        setError("LangSmith API key is required to enable tracing.");
        setIsSaving(false);
        setStep("api-key");
        setInput("");
        return;
      }

      await saveOpenWikiEnv({
        LANGCHAIN_TRACING_V2: enable ? "true" : "false",
      });

      setStep("menu");
      setInput("");
      setError(null);
    } catch (err) {
      onError(getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSaveApiKey(apiKey: string) {
    setIsSaving(true);

    try {
      await saveOpenWikiEnv({
        LANGSMITH_API_KEY: apiKey,
        LANGCHAIN_TRACING_V2: "true",
      });

      setStep("menu");
      setInput("");
      setError(null);
    } catch (err) {
      onError(getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSaveTraceName(traceName: string) {
    setIsSaving(true);

    try {
      await saveOpenWikiEnv({
        LANGCHAIN_PROJECT: traceName,
      });

      setStep("menu");
      setInput("");
      setError(null);
    } catch (err) {
      onError(getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }

  if (step === "menu") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>LangSmith Configuration</Text>
          <Text>
            Status: {isLangSmithEnabled ? "✔ Enabled" : "✗ Disabled"}
          </Text>
          {process.env.LANGSMITH_API_KEY && (
            <Text dimColor>
              API Key: {process.env.LANGSMITH_API_KEY.slice(0, 8)}...
            </Text>
          )}
          {process.env.LANGCHAIN_PROJECT && (
            <Text dimColor>
              Project: {process.env.LANGCHAIN_PROJECT}
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          {menuOptions.map((option, index) => (
            <Text key={option.id}>
              {index === menuIndex ? "> " : "  "}
              {option.label}
              {option.id === "toggle" &&
                ` (${isLangSmithEnabled ? "disable" : "enable"})`}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  if (step === "toggle-langsmith") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          {isLangSmithEnabled
            ? "Disable LangSmith tracing? (y/n)"
            : "Enable LangSmith tracing? (y/n)"}
        </Text>
        {error && <Text color="red">{error}</Text>}
      </Box>
    );
  }

  if (step === "api-key") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>Enter LangSmith API Key:</Text>
        <Text>{"> " + input}</Text>
        {error && <Text color="red">{error}</Text>}
      </Box>
    );
  }

  if (step === "trace-name") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>Enter LangSmith Project Name:</Text>
        <Text>{"> " + input}</Text>
        {error && <Text color="red">{error}</Text>}
      </Box>
    );
  }

  return null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
