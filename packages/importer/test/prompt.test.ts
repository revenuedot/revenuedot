// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: unit tests for the hidden terminal prompt the CLI uses to ask for secret keys.
// Docs: https://revenuedot.app/docs/migrate
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { PromptCancelled, terminalPrompt } from "../src/prompt.js";

/** A fake TTY: records raw-mode changes and what was written to the terminal. */
function fakeTty() {
  const input = Object.assign(new EventEmitter(), {
    isRaw: false, rawModes: [] as boolean[], paused: false,
    setRawMode(raw: boolean) { this.isRaw = raw; this.rawModes.push(raw); },
    setEncoding() {}, resume() { this.paused = false; }, pause() { this.paused = true; },
  });
  const written: string[] = [];
  const output = { write: (s: string) => { written.push(s); return true; } };
  return { input, output, written, type: (...chunks: string[]) => { for (const c of chunks) input.emit("data", c); } };
}

const KEY = "sk_AbCdEf0123456789";

describe("terminalPrompt", () => {
  it("reads a pasted key in raw mode without echoing it, then restores the terminal", async () => {
    const t = fakeTty();
    const answer = terminalPrompt(t.input, t.output)("Key: ", { hidden: true });
    t.type(`${KEY}\r`);
    expect(await answer).toBe(KEY);
    expect(t.written.join("")).toBe("Key: \n");
    expect(t.input.rawModes).toEqual([true, false]);
    expect(t.input.paused).toBe(true);
    expect(t.input.listenerCount("data")).toBe(0);
  });

  it("handles typing in pieces, backspace, Ctrl+U, arrow keys, bracketed paste and surrounding spaces", async () => {
    const t = fakeTty();
    const answer = terminalPrompt(t.input, t.output)("Key: ", { hidden: true });
    t.type("wrong", "\u0015", "sk_Ab", "X\u007f", "\u001b[D", "\u001b[200~CdEf0123456789  \u001b[201~", "\n");
    expect(await answer).toBe(KEY);
    expect(t.written.join("")).toBe("Key: \n");
  });

  it("rejects with PromptCancelled on Ctrl+C, and on Ctrl+D at an empty line", async () => {
    for (const key of ["sk_partial\u0003", "\u0004"]) {
      const t = fakeTty();
      const answer = terminalPrompt(t.input, t.output)("Key: ", { hidden: true });
      t.type(key);
      await expect(answer).rejects.toBeInstanceOf(PromptCancelled);
      expect(t.written.join("")).toBe("Key: \n");
      expect(t.input.rawModes).toEqual([true, false]);
    }
  });

  it("echoes when not hidden, and erases on backspace", async () => {
    const t = fakeTty();
    const answer = terminalPrompt(t.input, t.output)("Name: ", { hidden: false });
    t.type("abx\u007fc\r");
    expect(await answer).toBe("abc");
    expect(t.written.join("")).toBe("Name: abx\b \bc\n");
  });
});
