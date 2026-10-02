import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatStatus, FileUIPart } from "ai";
import { FileJson2Icon, PaperclipIcon, XIcon } from "lucide-react";
import {
  PromptInput, PromptInputBody, PromptInputButton, PromptInputFooter, PromptInputProvider, PromptInputSubmit, PromptInputTextarea, PromptInputTools,
  usePromptInputAttachments, usePromptInputController, type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { api } from "../../lib/api";
import { aiBase, isStoreKitPart, type Draft, type Mention } from "./data";

/**
 * The RevenueDot AI composer (prd/ai-assistant/PRD.md §3, §4): AI Elements PromptInput with Attach image (and .storekit
 * files), and `@` mentions of customers, offerings and charts. Typing `@` opens suggestions; picking one inserts `@label`
 * and attaches `{ type, id }` to the message. Enter sends, Shift+Enter adds a line.
 */
export interface ComposerSubmit { text: string; files: FileUIPart[]; mentions: Mention[] }

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function Composer(props: { pid: string; status?: ChatStatus; onStop?: () => void; onSubmit: (m: ComposerSubmit) => unknown; disabled?: boolean; autoFocus?: boolean; placeholder?: string; initial?: Draft | null }) {
  return (
    <PromptInputProvider>
      <ComposerInner {...props} />
    </PromptInputProvider>
  );
}

/** The word being typed after an `@` before the caret, or null when the caret is not in a mention. */
export function mentionQuery(value: string, caret: number | null): string | null {
  const m = /(?:^|\s)@([\w.:@-]{0,40})$/.exec(value.slice(0, Math.min(caret ?? value.length, value.length)));
  return m ? m[1]! : null;
}

function ComposerInner({ pid, status, onStop, onSubmit, disabled, autoFocus, placeholder, initial }: Parameters<typeof Composer>[0]) {
  const controller = usePromptInputController();
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [options, setOptions] = useState<{ query: string; items: Mention[] }>({ query: "", items: [] });
  const [active, setActive] = useState(0);
  // Escape closes the list until the text changes again.
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  // The caret after the last edit, read in the change handler (the same event as the text), not in an effect.
  const caret = useRef<number | null>(null);
  const value = controller.textInput.value;
  // A draft from another page (the chart page's Ask AI): the text with its mention, the caret at the end, not sent.
  const seeded = useRef(false);
  useEffect(() => {
    if (!initial || seeded.current) return;
    seeded.current = true;
    caret.current = initial.text.length;
    controller.textInput.setInput(initial.text);
    setMentions(initial.mentions);
    requestAnimationFrame(() => { const el = ref.current; el?.focus(); el?.setSelectionRange(initial.text.length, initial.text.length); });
  }, [initial, controller.textInput]);

  // The mention list follows the text in render. It used to be state set from an effect on every keystroke: each
  // keystroke's synchronous render then left a second update queued, and when keystrokes arrived faster than React's
  // scheduler ran (fast typing, a busy page) React counted 50 such commits in a row, threw "Maximum update depth
  // exceeded" (error #185) inside the next keystroke's setState and dropped that character.
  const query = dismissedAt === value ? null : mentionQuery(value, caret.current);
  useEffect(() => {
    if (query === null) return;
    let live = true;
    const t = setTimeout(() => {
      api<{ items: Mention[] }>(`${aiBase(pid)}/mentions?q=${encodeURIComponent(query)}`).then((r) => { if (live) { setOptions({ query, items: r.items }); setActive(0); } }).catch(() => {});
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [query, pid]);
  // Suggestions for the word being typed stay up while its next letters load; a new mention starts empty.
  const shown = query !== null && query.startsWith(options.query) ? options.items : [];

  const pick = (m: Mention) => {
    const el = ref.current;
    const at = el?.selectionStart ?? value.length;
    const before = value.slice(0, at).replace(/@([\w.:@-]{0,40})$/, `@${m.label} `);
    caret.current = before.length;
    controller.textInput.setInput(before + value.slice(at));
    setMentions((x) => (x.some((y) => y.type === m.type && y.id === m.id) ? x : [...x, m]));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(before.length, before.length); });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shown.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % shown.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + shown.length) % shown.length); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(shown[Math.min(active, shown.length - 1)]!); }
    else if (e.key === "Escape") { e.preventDefault(); setDismissedAt(value); }
  };

  const busy = status === "submitted" || status === "streaming";
  const submit = async (m: PromptInputMessage) => {
    // One answer at a time: Enter while an answer is being written keeps the text for later (the button is Stop).
    if (busy) throw new Error("busy");
    setError(null);
    const bad = m.files.find((f) => !IMAGE_TYPES.includes(f.mediaType) && !isStoreKitPart(f));
    if (bad) { setError(`${bad.filename ?? "That file"} is not a PNG, JPEG, WebP or GIF image or a .storekit file.`); throw new Error("bad file"); }
    if (!m.text.trim() && !m.files.length) return;
    // Only mentions still in the text go with the message.
    const used = mentions.filter((x) => m.text.includes(`@${x.label}`));
    await onSubmit({ text: m.text, files: m.files, mentions: used });
    setMentions([]);
  };

  return (
    <div className="ai-composer">
      {shown.length > 0 && (
        <div className="ai-mentions" role="listbox" aria-label="Mention">
          {shown.map((o, i) => (
            <button key={`${o.type}:${o.id}`} type="button" role="option" aria-selected={i === active} className={i === active ? "on" : undefined}
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
              <span className="t">{o.type}</span><b>@{o.label}</b><span className="d">{o.detail}</span>
            </button>
          ))}
        </div>
      )}
      <PromptInput onSubmit={submit} multiple maxFiles={4} maxFileSize={5 * 1024 * 1024} onError={(e) => setError(e.message)} className="ai-input">
        <Attachments />
        <PromptInputBody>
          <PromptInputTextarea ref={ref} onKeyDown={onKeyDown} onChange={(e) => { caret.current = e.currentTarget.selectionStart; }} autoFocus={autoFocus} disabled={disabled} aria-label="Ask RevenueDot AI"
            placeholder={placeholder ?? "Ask about insights or growth opportunities for your apps"} className="min-h-12 px-3.5 pt-3 text-sm" />
        </PromptInputBody>
        <PromptInputFooter className="px-2 pb-2">
          <PromptInputTools>
            <AttachButton />
            <span className="ai-hint">Type @ to mention a customer, offering or chart</span>
          </PromptInputTools>
          <PromptInputSubmit status={status} onStop={onStop} disabled={disabled || (!busy && !value.trim())} className="ai-send" />
        </PromptInputFooter>
      </PromptInput>
      {error && <div className="banner err" role="alert">{error}</div>}
    </div>
  );
}

function AttachButton() {
  const a = usePromptInputAttachments();
  return (
    <PromptInputButton onClick={() => a.openFileDialog()} aria-label="Attach image" className="ai-attach">
      <PaperclipIcon className="size-4" /><span>Attach image</span>
    </PromptInputButton>
  );
}

function Attachments() {
  const a = usePromptInputAttachments();
  if (!a.files.length) return null;
  return (
    <div className="ai-chips">
      {a.files.map((f) => (
        <span key={f.id} className="ai-chip">
          {f.mediaType?.startsWith("image/") ? <img src={f.url} alt="" /> : <FileJson2Icon className="size-4" />}
          <span className="n">{f.filename ?? "file"}</span>
          <button type="button" aria-label={`Remove ${f.filename ?? "file"}`} onClick={() => a.remove(f.id)}><XIcon className="size-3.5" /></button>
        </span>
      ))}
    </div>
  );
}
