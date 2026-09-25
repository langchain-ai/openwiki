import React from "react";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Header } from "../../../src/cli/components/header.tsx";
import { stripAnsi as plain } from "./ansi.ts";

const HEADER_ENV_KEYS = [
  "LANGCHAIN_TRACING_V2",
  "LANGSMITH_API_KEY",
  "OPENWIKI_REASONING_EFFORT",
] as const;

describe("Header", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of HEADER_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of HEADER_ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  test("compact form shows the wordmark, provider, and explicit model id", () => {
    const { lastFrame } = render(
      <Header compact modelId="my-model-id" subtitle="Agent running" />,
    );

    const frame = plain(lastFrame());
    expect(frame).toContain("OpenWiki");
    expect(frame).toContain("provider:");
    expect(frame).toContain("model:");
    expect(frame).toContain("my-model-id");
    expect(frame).toContain("Agent running");
  });

  test("full form shows provider, model, directory, and the usage tip", () => {
    const { lastFrame } = render(
      <Header modelId="opus" showLogo={false} subtitle="Development dry run" />,
    );

    const frame = plain(lastFrame());
    expect(frame).toContain("provider:");
    expect(frame).toContain("model:");
    expect(frame).toContain("directory:");
    expect(frame).toContain("Development dry run");
    expect(frame).toContain("/exit");
  });

  test("reports tracing disabled when the env vars are absent", () => {
    const { lastFrame } = render(<Header compact modelId="m" subtitle="s" />);
    expect(plain(lastFrame())).toContain("LangSmith tracing disabled");
  });

  test("reports tracing enabled when both env vars are set", () => {
    process.env.LANGCHAIN_TRACING_V2 = "true";
    process.env.LANGSMITH_API_KEY = "sk-test";

    const { lastFrame } = render(<Header compact modelId="m" subtitle="s" />);
    expect(plain(lastFrame())).toContain("LangSmith tracing enabled");
  });

  test("shows a saved reasoning effort in both header layouts", () => {
    process.env.OPENWIKI_REASONING_EFFORT = "medium";

    const compact = render(<Header compact modelId="m" subtitle="s" />);
    expect(plain(compact.lastFrame())).toContain("effort: medium");

    const full = render(<Header modelId="m" showLogo={false} subtitle="s" />);
    expect(plain(full.lastFrame())).toContain("reasoning effort: medium");
  });

  test("sanitizes control characters out of the model id", () => {
    const control = String.fromCharCode(1);
    const { lastFrame } = render(
      <Header compact modelId={`safe${control}model`} subtitle="s" />,
    );

    // The raw control byte must never reach the rendered frame.
    expect(lastFrame() ?? "").not.toContain(control);
  });
});
