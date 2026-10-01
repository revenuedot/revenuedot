// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: asks for a missing secret key on the terminal without echoing it, so keys stay out of shell history.
// Docs: https://revenuedot.app/docs/migrate

/** Asks one question on the terminal and resolves with the trimmed answer. Rejects with PromptCancelled on Ctrl+C. */
export type Prompt = (question: string, o: { hidden: boolean }) => Promise<string>;

/** The user pressed Ctrl+C (or Ctrl+D on an empty line) at a prompt; the CLI exits with code 130. */
export class PromptCancelled extends Error {
  constructor() { super("Cancelled."); this.name = "PromptCancelled"; }
}

interface TtyInput {
  isRaw?: boolean;
  setRawMode(raw: boolean): unknown;
  setEncoding(enc: "utf8"): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", fn: (chunk: string | Buffer) => void): unknown;
  removeListener(event: "data", fn: (chunk: string | Buffer) => void): unknown;
}
interface TtyOutput { write(s: string): unknown }

// Escape sequences (arrow keys, bracketed-paste markers ESC[200~ / ESC[201~) are dropped, never typed into the key.
const ESCAPES = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/g;

/**
 * Reads a line from a TTY in raw mode. With `hidden`, nothing of the answer is echoed: no characters, no asterisks.
 * Handles paste, Enter, Backspace, Ctrl+U (clear) and Ctrl+C. The question goes to `output` (stderr), never stdout.
 */
export function terminalPrompt(input: TtyInput = process.stdin as unknown as TtyInput, output: TtyOutput = process.stderr): Prompt {
  return (question, { hidden }) => new Promise<string>((resolve, reject) => {
    output.write(question);
    const wasRaw = Boolean(input.isRaw);
    let value = "";
    const finish = (cancelled: boolean) => {
      input.removeListener("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      if (cancelled) reject(new PromptCancelled());
      else resolve(value.trim());
    };
    const onData = (chunk: string | Buffer) => {
      for (const ch of String(chunk).replace(ESCAPES, "")) {
        if (ch === "\r" || ch === "\n") return finish(false);
        if (ch === "\u0003" || (ch === "\u0004" && !value)) return finish(true);
        if (ch === "\u007f" || ch === "\b") {
          if (value) { value = [...value].slice(0, -1).join(""); if (!hidden) output.write("\b \b"); }
          continue;
        }
        if (ch === "\u0015") { if (!hidden) output.write("\b \b".repeat([...value].length)); value = ""; continue; }
        if (ch < " ") continue;
        value += ch;
        if (!hidden) output.write(ch);
      }
    };
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.resume();
  });
}
