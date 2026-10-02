// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the Node server starts when docker compose passes optional AI settings as empty strings.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { dropEmptyBaseUrls } from "../src/env-defaults.js";

describe("empty *_BASE_URL settings (docker compose's `${OPENAI_BASE_URL:-}`)", () => {
  it("would stop the AI SDK's providers from loading, so they are unset before anything else is imported", () => {
    const saved = { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL };
    try {
      process.env.OPENAI_BASE_URL = "";
      process.env.ANTHROPIC_BASE_URL = " ";
      // What `import "@ai-sdk/openai"` does at load time (export const openai = createOpenAI()).
      expect(() => createOpenAI()).toThrow(/baseURL must be a non-empty string/);
      expect(() => createAnthropic()).toThrow(/baseURL must be a non-empty string/);
      expect(dropEmptyBaseUrls(process.env).sort()).toEqual(["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]);
      expect(() => createOpenAI()).not.toThrow();
      expect(() => createAnthropic()).not.toThrow();
      // A real value is kept.
      const env: Record<string, string> = { OPENAI_BASE_URL: "http://localhost:11434/v1", PORT: "" };
      expect(dropEmptyBaseUrls(env)).toEqual([]);
      expect(env).toEqual({ OPENAI_BASE_URL: "http://localhost:11434/v1", PORT: "" });
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it("runs as the Node entry's first import", () => {
    const entry = readFileSync(new URL("../src/entry.node.ts", import.meta.url), "utf8");
    const firstImport = entry.split("\n").find((l) => l.startsWith("import "));
    expect(firstImport).toBe('import "./env-defaults.js";');
  });
});
