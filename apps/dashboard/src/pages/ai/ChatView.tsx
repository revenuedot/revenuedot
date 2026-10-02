import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { defaultRehypePlugins } from "streamdown";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getToolName, isToolUIPart, type FileUIPart, type ToolUIPart, type UIMessage } from "ai";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Confirmation, ConfirmationAccepted, ConfirmationAction, ConfirmationActions, ConfirmationRejected, ConfirmationRequest, ConfirmationTitle } from "@/components/ai-elements/confirmation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion } from "@/components/ai-elements/suggestion";
import { Icon } from "../../components/icons";
import { api } from "../../lib/api";
import { Composer, type ComposerSubmit } from "./Composer";
import { aiBase, greeting, isStoreKitPart, uploadFiles, type AiStatus, type ChatLike, type Draft, type StoreKitConfig } from "./data";
import { describeRead, describeWrite, toolTitle, WRITE_TOOLS } from "./toolCopy";

export const EXAMPLES = [
  "How is revenue doing this month?",
  "Which offering converts trials best?",
  "Why are webhooks failing?",
  "Summarize churn over the last 90 days",
];

/** Links in answers ("[MRR chart](/projects/…/charts/mrr)") open inside the dashboard. */
function useInternalLinks() {
  const nav = useNavigate();
  return (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href");
    if (!a || !href || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (href.startsWith("/projects/")) { e.preventDefault(); nav(href); }
  };
}

/**
 * Answers are model output, and the model reads customer attributes, product names and other data anyone can write. So
 * markdown is rendered without raw HTML, an image never loads (a URL could carry data out without a click), and a link
 * is either a dashboard path or an https URL shown as written.
 */
const SAFE_REHYPE = [defaultRehypePlugins.sanitize!];
const SAFE_COMPONENTS = {
  img: ({ alt }: { alt?: string }) => <span className="subtle">{alt ? `[image: ${alt}]` : "[image]"}</span>,
  a: ({ href, children }: { href?: string; children?: ReactNode }) => {
    if (href && /^\/(?!\/)/.test(href)) return <a href={href}>{children}</a>;
    if (href && /^https:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer nofollow" title={href}>{children}</a>;
    return <span>{children}</span>;
  },
};

/** The empty state: greeting by name and time of day, what the assistant does, the composer and example questions. */
export function Welcome({ status, pid, onSubmit, draft }: { status: AiStatus; pid: string; onSubmit: (m: ComposerSubmit) => unknown; draft?: Draft | null }) {
  const [busy, setBusy] = useState(false);
  const go = async (m: ComposerSubmit) => { setBusy(true); try { await onSubmit(m); } finally { setBusy(false); } };
  return (
    <div className="ai-welcome">
      <h1><Icon name="spark" className="i gold" />{greeting(status.greeting_name)}</h1>
      <p>I'm RevenueDot AI. I read your revenue, customers and catalog, and I change things only after you approve.</p>
      <Composer pid={pid} onSubmit={go} status={busy ? "submitted" : "ready"} autoFocus initial={draft} />
      <div className="ai-examples">
        {EXAMPLES.map((q) => <Suggestion key={q} suggestion={q} onClick={() => go({ text: q, files: [], mentions: [] })} />)}
      </div>
      {!status.can_write && status.reason && <p className="ai-note">{status.reason}</p>}
    </div>
  );
}

/** One conversation: messages with tool and approval cards, errors with Retry, and the composer. */
export function ChatView({ pid, chat, status, interrupted, onSent }: { pid: string; chat: ChatLike; status: AiStatus; interrupted?: string | null; onSent?: () => void }) {
  const onClick = useInternalLinks();
  const busy = chat.status === "submitted" || chat.status === "streaming";
  const [storekit, setStorekit] = useState<Record<string, StoreKitConfig>>({});
  const send = async (m: ComposerSubmit) => {
    const up = await uploadFiles(pid, m.files);
    setStorekit((s) => ({ ...s, ...up.storekit }));
    await chat.sendMessage({ text: m.text, files: up.parts, metadata: m.mentions.length ? { mentions: m.mentions.map(({ type, id, label }) => ({ type, id, label })) } : undefined });
    onSent?.();
  };
  const last = chat.messages[chat.messages.length - 1];
  const waiting = chat.status === "submitted" || (chat.status === "streaming" && last?.role === "assistant" && !last.parts.some((p) => p.type === "text" || isToolUIPart(p)));
  return (
    <div className="ai-chat">
      <Conversation className="ai-scroll">
        <ConversationContent className="ai-messages" onClick={onClick}>
          {chat.messages.map((m) => <ChatMessage key={m.id} m={m} pid={pid} chat={chat} storekit={storekit} canWrite={status.can_write} />)}
          {waiting && <Message from="assistant"><MessageContent><Shimmer className="text-sm">Thinking…</Shimmer></MessageContent></Message>}
          {chat.error && (
            <div className="banner err ai-error" role="alert">
              <span>{chat.error.message || "Something went wrong."}</span>
              <button type="button" className="btn btn-line" onClick={() => { chat.clearError(); chat.regenerate(); }}>Retry</button>
            </div>
          )}
          {!chat.error && interrupted && !busy && (
            <div className="banner ai-error" role="status">
              <span>{interrupted}</span>
              <button type="button" className="btn btn-line" onClick={() => chat.regenerate()}>Retry</button>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="ai-dock">
        <Composer pid={pid} status={chat.status} onStop={() => chat.stop()} onSubmit={send} autoFocus />
      </div>
    </div>
  );
}

function ChatMessage({ m, pid, chat, storekit, canWrite }: { m: UIMessage; pid: string; chat: ChatLike; storekit: Record<string, StoreKitConfig>; canWrite: boolean }) {
  return (
    <Message from={m.role} data-role={m.role}>
      <MessageContent>
        {m.parts.map((p, i) => {
          if (p.type === "text") return m.role === "user" ? <p key={i} className="ai-user-text">{p.text}</p> : <MessageResponse key={i} linkSafety={{ enabled: false }} rehypePlugins={SAFE_REHYPE} components={SAFE_COMPONENTS as never}>{p.text}</MessageResponse>;
          if (p.type === "file") return isStoreKitPart(p) ? <StoreKitCard key={i} pid={pid} part={p} preloaded={storekit[p.url]} chat={chat} canWrite={canWrite} /> : <ImagePart key={i} part={p} />;
          if (isToolUIPart(p)) return <ToolPart key={p.toolCallId} part={p as ToolUIPart} chat={chat} />;
          return null;
        })}
      </MessageContent>
    </Message>
  );
}

function ImagePart({ part }: { part: FileUIPart }) {
  return part.mediaType?.startsWith("image/") ? <a className="ai-image" href={part.url} target="_blank" rel="noreferrer"><img src={part.url} alt={part.filename ?? "Attached image"} /></a> : null;
}

/** A tool call: an approval card for writes waiting on the user, else a collapsible card with input and result. */
function ToolPart({ part, chat }: { part: ToolUIPart; chat: ChatLike }) {
  const name = getToolName(part);
  const input = (part.input ?? {}) as Record<string, unknown>;
  const approval = (part as { approval?: { id: string; approved?: boolean; reason?: string } }).approval;
  const write = WRITE_TOOLS.has(name);
  const card = (
    <Tool className="ai-tool" data-tool={name} defaultOpen={part.state === "output-error"}>
      <ToolHeader type={part.type} state={part.state} title={`${toolTitle(name)}${!write && describeRead(name, input) ? ` · ${describeRead(name, input)}` : ""}`} />
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput output={part.state === "output-available" ? part.output : undefined} errorText={part.state === "output-error" ? part.errorText : undefined} />
      </ToolContent>
    </Tool>
  );
  if (!write || !approval) return card;
  return (
    <div className="ai-approval-wrap">
      <Confirmation approval={approval as never} state={part.state} className="ai-approval" data-testid="approval-card">
        <ConfirmationTitle>
          <span className="lab">{toolTitle(name)}</span>
          <span className="q">{describeWrite(name, input)}?</span>
          <ConfirmationRequest>
            <ApprovalArgs input={input} />
            <span className="ai-sub">Nothing changes until you approve. The change is recorded in the audit log as RevenueDot AI on your behalf.</span>
          </ConfirmationRequest>
        </ConfirmationTitle>
        <ConfirmationAccepted><p className="done"><Icon name="check" className="i up" />Approved</p></ConfirmationAccepted>
        <ConfirmationRejected><p className="done"><Icon name="close" className="i" />Denied. Nothing changed.</p></ConfirmationRejected>
        <ConfirmationActions>
          <ConfirmationAction variant="outline" onClick={() => chat.addToolApprovalResponse({ id: approval.id, approved: false })}>Deny</ConfirmationAction>
          <ConfirmationAction onClick={() => chat.addToolApprovalResponse({ id: approval.id, approved: true })}>Approve</ConfirmationAction>
        </ConfirmationActions>
      </Confirmation>
      {(part.state === "output-available" || part.state === "output-error") && card}
    </div>
  );
}

/** Every argument the write will run with, exactly as the server holds it (the summary above can leave some out). */
function ApprovalArgs({ input }: { input: Record<string, unknown> }) {
  const rows = Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!rows.length) return null;
  return (
    <dl className="ai-args" data-testid="approval-args">
      {rows.map(([k, v]) => <div key={k} className={isRows(v) ? "ai-args-rows" : undefined}><dt>{k}</dt><dd>{isRows(v) ? <ArgRows rows={v} /> : argText(v)}</dd></div>)}
    </dl>
  );
}

type ArgRow = Record<string, unknown>;
const isRows = (v: unknown): v is ArgRow[] => Array.isArray(v) && v.length > 0 && v.every((x) => !!x && typeof x === "object" && !Array.isArray(x));
/** One argument as text: lists joined, `{ amount, currency }` as "9.99 USD", other objects as JSON. */
function argText(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x !== "object" || x === null)) return v.join(", ");
  const o = v as Record<string, unknown>;
  if (typeof o.amount === "number" && typeof o.currency === "string") return `${o.amount} ${o.currency}`;
  if (!Array.isArray(v)) return Object.entries(o).filter(([, x]) => x !== undefined && x !== null && x !== "").map(([k, x]) => `${k}: ${typeof x === "object" ? JSON.stringify(x) : String(x)}`).join(" · ");
  return JSON.stringify(v);
}
/** A list of objects (the products of create-products, the packages of create-offering) as a small table. */
function ArgRows({ rows }: { rows: ArgRow[] }) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return (
    <div className="ai-argtable-wrap"><table className="ai-argtable" data-testid="approval-rows">
      <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c}>{argText(r[c])}</td>)}</tr>)}</tbody>
    </table></div>
  );
}

/** The `.storekit` viewer: the products in the file, with "Import into catalog" (the assistant asks before it writes). */
function StoreKitCard({ pid, part, preloaded, chat, canWrite }: { pid: string; part: FileUIPart; preloaded?: StoreKitConfig; chat: ChatLike; canWrite: boolean }) {
  const q = useQuery({
    queryKey: ["ai-storekit", part.url], enabled: !preloaded,
    queryFn: () => api<{ storekit: StoreKitConfig }>(`${part.url}?format=storekit`).then((r) => r.storekit),
  });
  const cfg = preloaded ?? q.data;
  const fileId = /\/ai\/files\/(\w+)$/.exec(part.url)?.[1];
  const [asked, setAsked] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (asked) ref.current?.scrollIntoView({ block: "nearest" }); }, [asked]);
  return (
    <div className="ai-storekit" ref={ref} data-testid="storekit-card">
      <div className="h"><b>{part.filename ?? "StoreKit configuration"}</b><span className="subtle">{cfg ? `${cfg.products.length} products${cfg.storefront ? ` · ${cfg.storefront}` : ""}` : "Reading…"}</span></div>
      {cfg && (
        <table className="tbl">
          <thead><tr><th>Product ID</th><th>Type</th><th>Price</th><th>Period</th><th>Intro offer</th></tr></thead>
          <tbody>
            {cfg.products.map((p) => (
              <tr key={p.productId}>
                <td className="mono">{p.productId}</td><td>{p.type.replace(/_/g, " ")}</td><td className="num">{p.price ?? "—"}</td><td className="mono">{p.duration ?? "—"}</td>
                <td>{p.introOffer ? `${p.introOffer.mode.replace(/_/g, " ")}${p.introOffer.period ? ` · ${p.introOffer.period}` : ""}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cfg?.warnings.length ? <p className="subtle">{cfg.warnings.join(" ")}</p> : null}
      {canWrite && fileId && cfg && cfg.products.length > 0 && (
        <div className="f">
          <button type="button" className="btn" disabled={asked} onClick={() => { setAsked(true); chat.sendMessage({ text: `Import the products from ${part.filename ?? "this StoreKit file"} (file_id ${fileId}) into the App Store app's catalog. Skip ones that already exist.` }); }}>
            {asked ? "Asked" : "Import into catalog"}
          </button>
        </div>
      )}
    </div>
  );
}

/** The base path for files and the like in this project, re-exported for the page. */
export const filesBase = (pid: string) => `${aiBase(pid)}/files`;
