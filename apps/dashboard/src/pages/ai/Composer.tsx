import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatStatus, FileUIPart } from "ai";
import { FileJson2Icon, PaperclipIcon, XIcon } from "lucide-react";
import {
  PromptInput, PromptInputBody, PromptInputButton, PromptInputFooter, PromptInputProvider, PromptInputSubmit, PromptInputTextarea, PromptInputTools,
  usePromptInputAttachments, usePromptInputController, type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { api } from "../../lib/api";
import { aiBase, isStoreKitPart, type Mention } from "./data";

/**
 * The RevenueDot AI composer (prd/ai-assistant/PRD.md §3, §4): AI Elements PromptInput with Attach image (and .storekit
 * files), and `@` mentions of customers, offerings and charts. Typing `@` opens suggestions; picking one inserts `@label`
 * and attaches `{ type, id }` to the message. Enter sends, Shift+Enter adds a line.
 */
export interface ComposerSubmit { text: string; files: FileUIPart[]; mentions: Mention[] }

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function Composer(props: { pid: string; status?: ChatStatus; onStop?: () => void; onSubmit: (m: ComposerSubmit) => unknown; disabled?: boolean; autoFocus?: boolean; placeholder?: string }) {
  return (
    <PromptInputProvider>
      <ComposerInner {...props} />
    </PromptInputProvider>
  );
}

function ComposerInner({ pid, status, onStop, onSubmit, disabled, autoFocus, placeholder }: Parameters<typeof Composer>[0]) {
  const controller = usePromptInputController();
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [options, setOptions] = useState<Mention[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const value = controller.textInput.value;

  // The word being typed after an `@` opens the mention list.
  useEffect(() => {
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const m = /(?:^|\s)@([\w.:@-]{0,40})$/.exec(value.slice(0, caret));
    setQuery(m ? m[1]! : null);
  }, [value]);
  useEffect(() => {
    if (query === null) { setOptions([]); return; }
    let live = true;
    const t = setTimeout(() => {
      api<{ items: Mention[] }>(`${aiBase(pid)}/mentions?q=${encodeURIComponent(query)}`).then((r) => { if (live) { setOptions(r.items); setActive(0); } }).catch(() => {});
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [query, pid]);

  const pick = (m: Mention) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@([\w.:@-]{0,40})$/, `@${m.label} `);
    controller.textInput.setInput(before + value.slice(caret));
    setMentions((x) => (x.some((y) => y.type === m.type && y.id === m.id) ? x : [...x, m]));
    setQuery(null);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(before.length, before.length); });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (query === null || !options.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % options.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + options.length) % options.length); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(options[active]!); }
    else if (e.key === "Escape") { e.preventDefault(); setQuery(null); }
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
      {query !== null && options.length > 0 && (
        <div className="ai-mentions" role="listbox" aria-label="Mention">
          {options.map((o, i) => (
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
          <PromptInputTextarea ref={ref} onKeyDown={onKeyDown} autoFocus={autoFocus} disabled={disabled} aria-label="Ask RevenueDot AI"
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
