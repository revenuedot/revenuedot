import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { ConfirmDialog, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { ChatView, Welcome } from "./ChatView";
import type { ComposerSubmit } from "./Composer";
import { aiBase, uploadFiles, useAiStatus, useConversations, type AiStatus, type ChatLike, type Conversation, type ConversationDetail, type Draft, type PendingMessage } from "./data";

/**
 * RevenueDot AI (/projects/:projectId/ai[/:conversationId], prd/ai-assistant/PRD.md §3): a history rail (search, New
 * conversation, rename, delete, Settings) and the chat. On RevenueDot Cloud each conversation is a Durable Object
 * reached over a WebSocket (`useAgentChat`); self-hosted servers stream over SSE from Postgres (`useChat`). Both render
 * the same ChatView. Frame 29 of the RevenueCat study is the reference layout.
 */
export function AssistantPage() {
  const { projectId: pid = "", conversationId } = useParams();
  const status = useAiStatus(pid);
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const start = async (m: ComposerSubmit) => {
    try {
      const conv = await api<Conversation>(`${aiBase(pid)}/conversations`, { method: "POST", json: {} });
      const up = await uploadFiles(pid, m.files);
      await qc.invalidateQueries({ queryKey: ["ai-conversations", pid] });
      const pending: PendingMessage = { text: m.text, files: up.parts, metadata: m.mentions.length ? { mentions: m.mentions } : undefined };
      nav(`/projects/${pid}/ai/${conv.id}`, { state: { pending } });
    } catch (e) {
      toast(e instanceof Error ? e.message : "The conversation could not be started.");
      throw e;
    }
  };

  const s = status.data;
  const draft = (useLocation().state as { draft?: Draft } | null)?.draft ?? null;
  return (
    <Shell title="RevenueDot AI" crumbs={<b>RevenueDot AI</b>}>
      <div className="ai-page rd-ai">
        {s?.available && <HistoryRail pid={pid} current={conversationId} />}
        <section className="ai-main">
          {status.isLoading ? null : status.isError || !s ? (
            <div className="ai-off"><p className="banner err" role="alert">RevenueDot AI could not be loaded.</p></div>
          ) : !s.available ? (
            <Unavailable pid={pid} s={s} />
          ) : conversationId ? (
            <ConversationLoader key={conversationId} pid={pid} id={conversationId} status={s} />
          ) : (
            <Welcome status={s} pid={pid} onSubmit={start} draft={draft} />
          )}
        </section>
      </div>
    </Shell>
  );
}

function Unavailable({ pid, s }: { pid: string; s: AiStatus }) {
  return (
    <div className="ai-off" data-testid="ai-unavailable">
      <h1><Icon name="spark" className="i gold" />RevenueDot AI</h1>
      {!s.configured ? (
        <>
          <p>No model is configured on this server.</p>
          <p className="subtle">Self-hosted: set <code>ANTHROPIC_API_KEY</code> (Claude Opus 5.5) or <code>OPENAI_API_KEY</code> (GPT-6 Astra) and restart. RevenueDot Cloud uses Workers AI.</p>
        </>
      ) : <p>{s.reason}</p>}
      {s.role === "admin" && <p><Link className="btn btn-line" to={`/projects/${pid}/settings/ai`}>AI features settings</Link></p>}
    </div>
  );
}

function HistoryRail({ pid, current }: { pid: string; current?: string }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 200); return () => clearTimeout(t); }, [q]);
  const list = useConversations(pid, debounced);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["ai-conversations", pid] });
  const rename = async (id: string) => {
    if (title.trim()) await api(`${aiBase(pid)}/conversations/${id}`, { method: "POST", json: { title: title.trim() } }).catch(() => {});
    setRenaming(null);
    refresh();
  };
  return (
    <aside className="ai-rail" aria-label="Conversations">
      <div className="ai-rail-h"><span className="label">Chat history</span></div>
      <div className="ai-rail-search"><Icon name="search" /><input aria-label="Search chats" placeholder="Search chats…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <button type="button" className="ai-new" onClick={() => nav(`/projects/${pid}/ai`)}><Icon name="plus" />New conversation</button>
      <nav className="ai-list">
        {list.data?.map((c) => renaming === c.id ? (
          <form key={c.id} className="ai-item editing" onSubmit={(e) => { e.preventDefault(); void rename(c.id); }}>
            <input className="input" autoFocus aria-label="Conversation title" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void rename(c.id)}
              onKeyDown={(e) => { if (e.key === "Escape") setRenaming(null); }} />
          </form>
        ) : (
          <div key={c.id} className={`ai-item${c.id === current ? " active" : ""}`}>
            <Link to={`/projects/${pid}/ai/${c.id}`} title={c.title}>{c.title}</Link>
            <button type="button" className="ai-more" aria-label={`More for ${c.title}`} aria-expanded={menu === c.id} onClick={() => setMenu(menu === c.id ? null : c.id)}><Icon name="more" /></button>
            {menu === c.id && (
              <div className="menu ai-item-menu" role="menu" onMouseLeave={() => setMenu(null)}>
                <button role="menuitem" type="button" onClick={() => { setMenu(null); setTitle(c.title); setRenaming(c.id); }}><Icon name="edit" />Rename</button>
                <button role="menuitem" type="button" onClick={() => { setMenu(null); setDeleting(c); }}><Icon name="trash" />Delete</button>
              </div>
            )}
          </div>
        ))}
        {list.data && !list.data.length && <p className="subtle ai-empty">{debounced ? "No conversation matches." : "Your conversations show up here."}</p>}
      </nav>
      <div className="ai-rail-f">
        <span className="label">Configuration</span>
        <Link className="ai-cfg" to={`/projects/${pid}/settings/ai`}><Icon name="settings" />Settings</Link>
      </div>
      {deleting && (
        <ConfirmDialog title={`Delete "${deleting.title}"?`} confirmLabel="Delete conversation" danger onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`${aiBase(pid)}/conversations/${deleting.id}`, { method: "DELETE" });
            setDeleting(null);
            await refresh();
            if (deleting.id === current) nav(`/projects/${pid}/ai`);
          }}>
          <p>The conversation and its messages are deleted. Changes the assistant made stay, and stay in the audit log.</p>
        </ConfirmDialog>
      )}
    </aside>
  );
}

function ConversationLoader({ pid, id, status }: { pid: string; id: string; status: AiStatus }) {
  const conv = useQuery({ queryKey: ["ai-conversation", pid, id], queryFn: () => api<ConversationDetail>(`${aiBase(pid)}/conversations/${id}`), staleTime: Infinity, retry: false });
  if (conv.isLoading) return null;
  if (conv.isError || !conv.data) return <div className="ai-off"><p>This conversation was not found. It may have been deleted.</p><p><Link className="btn btn-line" to={`/projects/${pid}/ai`}>New conversation</Link></p></div>;
  return conv.data.runtime === "durable_object"
    ? <DurableObjectChat pid={pid} conv={conv.data} status={status} />
    : <SseChat pid={pid} conv={conv.data} status={status} />;
}

/** Sends the message the empty page handed over, once, then clears it from the history entry. */
function usePending(chat: ChatLike, ready: boolean) {
  const loc = useLocation();
  const nav = useNavigate();
  const sent = useRef(false);
  useEffect(() => {
    const pending = (loc.state as { pending?: PendingMessage } | null)?.pending;
    if (!pending || sent.current || !ready) return;
    sent.current = true;
    nav(loc.pathname, { replace: true, state: null });
    void chat.sendMessage({ text: pending.text, files: pending.files, metadata: pending.metadata?.mentions?.length ? { mentions: pending.metadata.mentions.map(({ type, id, label, params }) => ({ type, id, label, ...(params ? { params } : {}) })) } : undefined });
  }, [loc, ready, chat, nav]);
}

/** Self-host: POST …/chat streams the answer over SSE; GET …/stream resumes it after a reload. */
function SseChat({ pid, conv, status }: { pid: string; conv: ConversationDetail; status: AiStatus }) {
  const qc = useQueryClient();
  const base = `${aiBase(pid)}/conversations/${conv.id}`;
  const transport = useMemo(() => new DefaultChatTransport({
    api: `${base}/chat`, credentials: "same-origin",
    prepareSendMessagesRequest: ({ messages, trigger, messageId }) => ({ body: { trigger, messageId, message: trigger === "regenerate-message" ? undefined : messages[messages.length - 1] } }),
    prepareReconnectToStreamRequest: () => ({ api: `${base}/stream`, credentials: "same-origin" }),
  }), [base]);
  const chat = useChat({
    id: conv.id, messages: conv.messages, transport, resume: conv.streaming,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => { void qc.invalidateQueries({ queryKey: ["ai-conversations", pid] }); void qc.invalidateQueries({ queryKey: ["ai-status", pid] }); },
  });
  const like: ChatLike = {
    ...chat,
    stop: () => { void chat.stop(); void api(`${base}/stop`, { method: "POST" }).catch(() => {}); },
  } as ChatLike;
  usePending(like, true);
  const interrupted = conv.last_stream && ["interrupted", "error"].includes(conv.last_stream.status) && chat.messages.length === conv.messages.length
    ? "The last answer stopped before it finished." : null;
  return <ChatView pid={pid} chat={like} status={status} interrupted={interrupted} onSent={() => void qc.invalidateQueries({ queryKey: ["ai-conversations", pid] })} />;
}

/** RevenueDot Cloud: the conversation's Durable Object over a WebSocket (resumable streams, recovery, approvals built in). */
function DurableObjectChat({ pid, conv, status }: { pid: string; conv: ConversationDetail; status: AiStatus }) {
  const qc = useQueryClient();
  const agent = useAgent({ agent: "assistant-agent", name: conv.id });
  const chat = useAgentChat({ agent, credentials: "same-origin", onFinish: () => { void qc.invalidateQueries({ queryKey: ["ai-conversations", pid] }); } });
  const like = chat as unknown as ChatLike;
  usePending(like, true);
  return <ChatView pid={pid} chat={like} status={status} onSent={() => void qc.invalidateQueries({ queryKey: ["ai-conversations", pid] })} />;
}
