import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { DataTable, EmptyState, Field, Tag } from "../../components/ui";
import { api, fmt, type List } from "../../lib/api";
import { base, errMsg, type Collaborator } from "./data";
import { DateField } from "../../components/DateField";

/** Audit logs tab: who changed what in the project, newest first, with a date filter. `GET /v2/projects/{id}/audit_logs`. */
interface Log {
  id: string; action_type: string; target_type: string; target_identifier: string; actor_type: string; actor_identifier: string; occurred_at: number;
  additional_data: Record<string, unknown>;
}

const ACTOR: Record<string, string> = { assistant: "RevenueDot AI", user: "Dashboard user", api_key: "API key", oauth_client: "AI assistant (OAuth)", system: "System", service_account: "Service account" };
const label = (action: string) => action.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function AuditLogs({ pid }: { pid: string }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const q = useInfiniteQuery({
    queryKey: ["audit-logs", pid, from, to],
    initialPageParam: "" as string,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: "50" });
      if (from) p.set("start_date", from);
      if (to) p.set("end_date", to);
      if (pageParam) p.set("starting_after", pageParam);
      return api<List<Log>>(`${base(pid)}/audit_logs?${p}`);
    },
    getNextPageParam: (last) => (last.next_page ? new URL(last.next_page, "http://x").searchParams.get("starting_after") ?? undefined : undefined),
    enabled: !!pid,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  // Show people by email, as RevenueCat does; someone who has left the project keeps their user id.
  const people = useQuery({ queryKey: ["collaborators", pid], enabled: !!pid, queryFn: async () => (await api<List<Collaborator>>(`${base(pid)}/collaborators`)).items });
  const emailOf = (id: string) => people.data?.find((m) => m.id === id)?.email;
  return (
    <div className="panel pb" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
        <Field label="From" htmlFor="al-from"><DateField id="al-from" label="From" value={from} max={to || undefined} onChange={setFrom} /></Field>
        <Field label="To" htmlFor="al-to"><DateField id="al-to" label="To" value={to} min={from || undefined} onChange={setTo} /></Field>
        {(from || to) && <button type="button" className="btn btn-line" onClick={() => { setFrom(""); setTo(""); }}>Clear</button>}
      </div>
      {q.isError ? <div className="banner err" role="alert">The audit log could not be loaded: {errMsg(q.error)}</div> : q.isLoading ? <div className="subtle">Loading…</div> : !rows.length ? (
        <EmptyState title="No changes recorded" text="Every successful change made through the dashboard, an API key or an AI assistant shows up here with who made it." />
      ) : (
        <DataTable rowKey={(r) => r.id} rows={rows} columns={[
          { key: "when", header: "When", render: (r) => <span title={fmt.dateTime(r.occurred_at)}>{fmt.dateTime(r.occurred_at)}</span> },
          { key: "what", header: "What", className: "w2", render: (r) => label(r.action_type) },
          { key: "target", header: "Target", className: "w2", render: (r) => <><code>{r.target_identifier}</code><span className="cellsub">{r.target_type.replace(/_/g, " ")}</span></> },
          { key: "who", header: "Who", className: "w2", render: (r) => r.actor_type === "assistant"
            // RevenueDot AI acting after the person approved the change in the chat.
            ? <><Tag tone="gold">RevenueDot AI</Tag><span className="cellsub">on behalf of <code>{String(r.additional_data.actor_display ?? "").replace(/^assistant on behalf of /, "") || r.actor_identifier}</code></span></>
            : <><Tag tone={r.actor_type === "oauth_client" ? "gold" : "muted"}>{ACTOR[r.actor_type] ?? r.actor_type}</Tag><span className="cellsub">{r.actor_type === "user" && emailOf(r.actor_identifier) ? <span title={r.actor_identifier}>{emailOf(r.actor_identifier)}</span> : <code>{r.actor_identifier}</code>}</span></> },
        ]} />
      )}
      {q.hasNextPage && <button type="button" className="btn btn-line" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{q.isFetchingNextPage ? "Loading…" : "Load more"}</button>}
    </div>
  );
}
