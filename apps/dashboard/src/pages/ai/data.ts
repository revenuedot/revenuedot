import { useQuery } from "@tanstack/react-query";
import type { ChatStatus, FileUIPart, UIMessage } from "ai";
import { api } from "../../lib/api";

/** RevenueDot AI's API (prd/ai-assistant/PRD.md §6). */
export const aiBase = (pid: string) => `/v2/projects/${pid}/ai`;

export interface AiStatus {
  configured: boolean; available: boolean; provider: string | null; model: string | null; runtime: "durable_object" | "sse";
  access: "read_write" | "read_only" | "disabled"; role: string; can_read: boolean; can_write: boolean; reason: string | null;
  greeting_name: string | null; tools: { name: string; title: string; write: boolean }[];
  usage: { user: { turns: number; tokens: number }; project: { turns: number; tokens: number }; server: { turns: number; tokens: number } } | null;
  caps: { userTurnsPerDay: number; userTokensPerDay: number; projectTurnsPerDay: number; projectTokensPerDay: number };
}
export interface Conversation { id: string; title: string; runtime: "durable_object" | "postgres"; created_at: number; updated_at: number }
export interface ConversationDetail extends Conversation { messages: UIMessage[]; streaming: boolean; last_stream: { status: string; error: string | null } | null }
export interface Mention { type: "customer" | "offering" | "chart"; id: string; label: string; detail?: string; /** A chart's view from the chart page's Ask AI. */ params?: Record<string, string> }
/** What the chart page's Ask AI hands to the empty assistant page: a question with the chart mentioned. */
export interface Draft { text: string; mentions: Mention[] }
export interface StoreKitProduct {
  productId: string; referenceName: string; type: string; price: number | null; duration: string | null; group: string | null; displayName: string | null;
  introOffer: { mode: string; period: string | null; periods: number; price: number | null } | null;
}
export interface StoreKitConfig { formatVersion: number | null; storefront: string | null; products: StoreKitProduct[]; warnings: string[] }

export const useAiStatus = (pid: string) => useQuery({ queryKey: ["ai-status", pid], queryFn: () => api<AiStatus>(aiBase(pid)), enabled: !!pid });
export const useConversations = (pid: string, q = "") => useQuery({
  queryKey: ["ai-conversations", pid, q],
  queryFn: () => api<{ items: Conversation[] }>(`${aiBase(pid)}/conversations${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => r.items),
  enabled: !!pid,
});

/** What every chat runtime gives the view: the AI SDK `useChat` surface the page uses. */
export interface ChatLike {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  sendMessage: (m: { text: string; files?: FileUIPart[]; metadata?: unknown }) => unknown;
  regenerate: () => unknown;
  stop: () => unknown;
  clearError: () => unknown;
  addToolApprovalResponse: (o: { id: string; approved: boolean; reason?: string }) => unknown;
}

/** A message the empty page hands to the conversation it just created. */
export interface PendingMessage { text: string; files: FileUIPart[]; metadata?: { mentions?: Mention[] } }

/** Uploads composer attachments (blob or data URLs) to POST /ai/files; returns file parts that point at the server copy. */
export async function uploadFiles(pid: string, files: FileUIPart[]): Promise<{ parts: FileUIPart[]; storekit: Record<string, StoreKitConfig> }> {
  const parts: FileUIPart[] = [];
  const storekit: Record<string, StoreKitConfig> = {};
  for (const f of files) {
    const blob = await (await fetch(f.url)).blob();
    const name = f.filename ?? "attachment";
    const isStoreKit = /\.storekit$/i.test(name);
    const res = await api<{ id: string; url: string; media_type: string; storekit?: StoreKitConfig }>(`${aiBase(pid)}/files?name=${encodeURIComponent(name)}`, {
      method: "POST", body: blob, headers: { "content-type": isStoreKit ? "application/octet-stream" : f.mediaType || blob.type },
    });
    if (res.storekit) storekit[res.url] = res.storekit;
    parts.push({ type: "file", url: res.url, mediaType: res.media_type, filename: name });
  }
  return { parts, storekit };
}

export const isStoreKitPart = (p: { mediaType?: string; filename?: string }) => p.mediaType === "application/x-storekit+json" || /\.storekit$/i.test(p.filename ?? "");

/** "Morning, Ada": morning before 12, afternoon before 18, evening after (local time). */
export function greeting(name: string | null, now = new Date()) {
  const h = now.getHours();
  const part = h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
  return name ? `${part}, ${name}` : `Good ${part.toLowerCase()}`;
}
