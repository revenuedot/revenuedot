import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, fmt } from "../lib/api";
import { Icon } from "./icons";
import { CodeBlock, Tag, useToast } from "./ui";

/**
 * Delivery details for a webhook or partner integration delivery (GET …/deliveries/{id}): what was sent (method, URL,
 * headers with Authorization masked, the exact body), every attempt with its time, HTTP status, latency and the first
 * 4 KB of the answer (secrets scrubbed by the server), the next retry, Retry and Copy as cURL. Admins and Developers
 * only: the API answers 403 to Viewers, and the drawer says so.
 */
export interface DeliveryAttempt { attempted_at: number; response_status: number | null; response_ms: number | null; error: string | null; response_body: string | null; signature?: string | null; request?: string | null }
export interface DeliveryDetail {
  id: string; event_id: string; event_type: string; status: "pending" | "delivered" | "failed" | "skipped"; attempts: number; next_attempt_at: number | null;
  last_error: string | null; created_at: number; sent_as?: string | null;
  /** Webhooks: the request exactly as sent. */
  request?: { method: string; url: string; headers: { name: string; value: string }[]; body: string } | string | null;
  /** Integrations: the last request's body, credentials removed. */
  request_body?: string | null;
  curl: string | null; attempt_log: DeliveryAttempt[]; attempt_log_kept_days: number;
}

const TONE: Record<string, "up" | "info" | "down" | "muted"> = { delivered: "up", pending: "info", failed: "down", skipped: "muted" };
const pretty = (body: string) => { try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; } };
const ok = (s: number | null) => s !== null && s >= 200 && s < 300;
/** Attempts the server keeps per delivery (services/webhooks.ts ATTEMPT_LOG_MAX). */
const MAX_KEPT = 10;

/**
 * `canRetry` says whether "Retry now" applies to the delivery as loaded: anything not delivered and not already due. (An
 * integration delivery a tick is sending right now also reads as pending; the server answers 409 and the toast says so.)
 */
export function DeliveryDrawer({ path, title, onClose, onRetry, canRetry }: { path: string; title: string; onClose: () => void; onRetry?: () => Promise<void>; canRetry?: (d: DeliveryDetail) => boolean }) {
  const toast = useToast();
  const close = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [retrying, setRetrying] = useState(false);
  // While pending: every 2 s when the attempt is due (just retried), else every 5 s.
  const q = useQuery({ queryKey: ["delivery", path], queryFn: () => api<DeliveryDetail>(path), retry: false,
    refetchInterval: (x) => (x.state.data?.status !== "pending" ? false : (x.state.data.next_attempt_at ?? 0) <= Date.now() ? 2000 : 5000) });
  // Focus moves in once on open and back to where it was on close; the parent re-rendering (its list refreshes every few
  // seconds) must not pull focus to the close button again.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); before?.focus(); };
  }, []);
  const d = q.data;
  const forbidden = q.error instanceof ApiError && q.error.status === 403;
  const req = d && typeof d.request === "object" && d.request ? d.request : null;
  const copyCurl = async () => { if (!d?.curl) return; try { await navigator.clipboard.writeText(d.curl); toast("cURL copied. Credentials are left as placeholders."); } catch { toast("The clipboard is blocked in this browser."); } };
  const retry = async () => { if (!onRetry) return; setRetrying(true); try { await onRetry(); await q.refetch(); } finally { setRetrying(false); } };
  return (
    <div className="drawer-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Delivery details">
        <div className="drawer-h">
          <div style={{ minWidth: 0 }}>
            <span className="label">Delivery details</span>
            <h2>{title}</h2>
          </div>
          <button ref={close} type="button" className="ib" aria-label="Close delivery details" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="drawer-b">
          {q.isLoading && <p className="subtle">Loading the delivery…</p>}
          {forbidden && <div className="banner" role="status">Only Admins and Developers can see what was sent and the answers, because they can hold customer data.</div>}
          {q.isError && !forbidden && <div className="banner err" role="alert">{q.error instanceof Error ? q.error.message : "The delivery could not be loaded."}</div>}
          {d && (
            <>
              <div className="hrow" style={{ flexWrap: "wrap", gap: 8 }}>
                <Tag tone={TONE[d.status] ?? "muted"}>{d.status}</Tag>
                <span className="subtle">{d.attempts} attempt{d.attempts === 1 ? "" : "s"} · created {fmt.dateTime(d.created_at)}</span>
                {d.status === "pending" && d.next_attempt_at && <span className="subtle">· next attempt {d.next_attempt_at <= Date.now() ? "now" : fmt.dateTime(d.next_attempt_at)}</span>}
              </div>
              {d.last_error && d.status !== "delivered" && <div className="banner err" role="status">{d.last_error}</div>}

              <section className="drawer-s" aria-label="Request">
                <h3>Request</h3>
                {req ? (
                  <>
                    <p className="mono drawer-url"><b>{req.method}</b> {req.url}</p>
                    <table className="compact drawer-headers"><tbody>{req.headers.map((h) => <tr key={h.name}><th scope="row">{h.name}</th><td className="mono">{h.value}</td></tr>)}</tbody></table>
                    <CodeBlock label="Body" code={pretty(req.body)} />
                  </>
                ) : (
                  <>
                    {typeof d.request === "string" && d.request && <p className="mono drawer-url">{d.request}</p>}
                    {d.sent_as && <p className="subtle" style={{ margin: 0 }}>Sent as <code>{d.sent_as}</code>. Credentials are never stored.</p>}
                    <CodeBlock label="Body" code={d.request_body ? pretty(d.request_body) : "(nothing sent yet)"} />
                  </>
                )}
              </section>

              <section className="drawer-s" aria-label="Attempts">
                <h3>Attempts</h3>
                {!d.attempt_log.length ? (
                  <p className="subtle" style={{ margin: 0 }}>{d.attempts ? `Attempt details are kept for ${d.attempt_log_kept_days} days.` : "Not sent yet."}</p>
                ) : (
                  <>
                  {(d.attempt_log.length < d.attempts || d.attempt_log.length >= MAX_KEPT) && <p className="subtle" style={{ margin: 0 }}>The latest {MAX_KEPT} attempts of the last {d.attempt_log_kept_days} days are kept.</p>}
                  <ol className="drawer-attempts">
                    {[...d.attempt_log].reverse().map((a, i) => (
                      <li key={a.attempted_at + ":" + i}>
                        <div className="hrow" style={{ flexWrap: "wrap", gap: 8 }}>
                          <b>Attempt {d.attempt_log.length - i}</b>
                          <Tag tone={ok(a.response_status) ? "up" : "down"}>{a.response_status !== null ? `HTTP ${a.response_status}` : "No answer"}</Tag>
                          <span className="subtle mono">{a.response_ms !== null ? `${a.response_ms} ms` : ""}</span>
                          <span className="subtle" title={fmt.dateTime(a.attempted_at)}>{fmt.dateTime(a.attempted_at)}</span>
                        </div>
                        {a.error && a.error !== `HTTP ${a.response_status}` && <p className="drawer-err">{a.error}</p>}
                        {a.request && a.request !== (typeof d.request === "string" ? d.request : null) && <p className="mono subtle drawer-url">{a.request}</p>}
                        {a.signature && <p className="mono subtle drawer-url">X-RevenueCat-Webhook-Signature: {a.signature}</p>}
                        <CodeBlock label="Response body (first 4 KB)" code={a.response_body ? pretty(a.response_body) : "(empty)"} />
                      </li>
                    ))}
                  </ol>
                  </>
                )}
              </section>
            </>
          )}
        </div>
        <div className="drawer-f">
          {d?.curl && <button type="button" className="btn btn-line" onClick={copyCurl}><Icon name="copy" />Copy as cURL</button>}
          {onRetry && d && canRetry?.(d) && <button type="button" className="btn btn-dark" disabled={retrying} onClick={retry}><Icon name="refresh" />{retrying ? "Retrying…" : "Retry now"}</button>}
          <button type="button" className="btn btn-line" onClick={onClose}>Done</button>
        </div>
      </aside>
    </div>
  );
}
