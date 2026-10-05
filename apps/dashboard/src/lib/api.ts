import { formatUsd } from "./prefs";
import { trackRequest } from "./analytics";

/** Thin client for the RevenueDot API. The dashboard uses the session cookie; errors surface RevenueCat-style messages. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public body: unknown) { super(message); }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(init.json); }
  const res = await fetch(path, { ...init, headers, body, credentials: "same-origin" });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const msg = (data && typeof data === "object" && "message" in data ? String((data as { message: unknown }).message) : null) ?? `Request failed (${res.status})`;
    // Cloud's go-live gate refused an edit (paywalls, experiments, targeting): the Shell explains it and offers Pro.
    // Previews and estimates fail quietly in their own forms instead.
    const method = (init.method ?? "GET").toUpperCase();
    if (res.status === 402 && method !== "GET" && data && typeof data === "object" && (data as { type?: unknown }).type === "plan_required" && /^\/v2\/projects\/[^/]+\/(paywalls|experiments|targeting_rules|audiences)(\/|\?|$)/.test(path) && !/\/(preview|estimate)\b/.test(path) && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("rd:plan-required", { detail: msg }));
    }
    throw new ApiError(res.status, msg, data);
  }
  trackRequest(init.method ?? "GET", path, init.json);
  return data as T;
}

export interface List<T> { object: "list"; items: T[]; next_page: string | null; url: string }

export const fmt = {
  /** A USD amount from the API, shown in the person's display currency (Account settings → Date and region). */
  usd: (n: number | null | undefined, cents = false) => n === null || n === undefined ? "—" : formatUsd(n, cents),
  /** Always USD: what RevenueDot Cloud charges, and public pages that everyone sees in USD. */
  usdRaw: (n: number | null | undefined, cents = false) => n === null || n === undefined ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }),
  int: (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US")),
  date: (ms: number | string | null | undefined) => { if (!ms) return "—"; const d = new Date(ms); return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); },
  dateTime: (ms: number | string | null | undefined) => { if (!ms) return "—"; const d = new Date(ms); return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); },
  ago: (ms: number | string | null | undefined) => {
    if (!ms) return "never";
    const s = Math.max(0, Math.round((Date.now() - new Date(ms).getTime()) / 1000));
    if (s < 60) return `${s}s ago`; const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60); if (h < 48) return `${h} h ago`; return `${Math.round(h / 24)} days ago`;
  },
};
