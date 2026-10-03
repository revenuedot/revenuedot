// RevenueDot Enterprise (ee/LICENSE). Organization settings, Audit log tab: retention and the organization's own log.
import { useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmt, type List } from "../../../apps/dashboard/src/lib/api";
import { ConfirmDialog, DataTable, EmptyState, Field, Tag, useToast } from "../../../apps/dashboard/src/components/ui";
import { CONTACT_SALES } from "../locked";
import { base, errMsg, isAdmin, label, type OrgLog, type Overview } from "../lib";

const RETENTION = [
  { value: "", label: "Keep forever" }, { value: "90", label: "90 days" }, { value: "365", label: "1 year" }, { value: "730", label: "2 years" },
  { value: "1095", label: "3 years" }, { value: "1825", label: "5 years" }, { value: "2555", label: "7 years" }, { value: "3650", label: "10 years" },
];
const ACTOR: Record<string, string> = { user: "Dashboard user", scim: "SCIM", sso: "Single sign-on", system: "System" };

export function AuditLogTab({ org }: { org: Overview }) {
  const qc = useQueryClient();
  const toast = useToast();
  const owner = org.your_role === "owner";
  const [pending, setPending] = useState<string | null>(null);
  const current = org.audit_retention_days === null ? "" : String(org.audit_retention_days);
  const options = RETENTION.some((r) => r.value === current) ? RETENTION : [...RETENTION, { value: current, label: `${current} days` }];
  const q = useInfiniteQuery({
    queryKey: ["org-audit", org.id],
    initialPageParam: "" as string,
    queryFn: ({ pageParam }) => api<List<OrgLog>>(`${base(org.id)}/audit_logs?limit=50${pageParam ? `&starting_after=${pageParam}` : ""}`),
    getNextPageParam: (last) => (last.next_page ? new URL(last.next_page, "http://x").searchParams.get("starting_after") ?? undefined : undefined),
    enabled: isAdmin(org),
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const apply = async (value: string) => {
    await api(base(org.id), { method: "POST", json: { audit_retention_days: value ? Number(value) : null } });
    await qc.invalidateQueries({ queryKey: ["org", org.id] });
    toast(value ? `Audit logs are kept for ${options.find((o) => o.value === value)?.label}.` : "Audit logs are kept forever.");
  };
  const shorter = (v: string) => v !== "" && (current === "" || Number(v) < Number(current));
  return (
    <div className="stack">
      {!org.features.includes("audit_retention") && (
        <section className="panel" data-locked="audit_retention">
          <div className="ph"><b>Retention</b></div>
          <div className="pb"><p className="section-sub">{org.plan ? "Entries are kept 90 days on Cloud Free and Cloud Standard. " : ""}Choosing how long to keep them, up to 10 years, is part of Enterprise. <a href={CONTACT_SALES} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>Contact sales</a>.</p></div>
        </section>
      )}
      {org.features.includes("audit_retention") && (
        <section className="panel">
          <div className="ph"><b>Retention</b></div>
          <div className="pb stack">
            <Field label="Keep audit logs for" htmlFor="retention" hint={`Applies to this organization's log and the audit logs of its ${org.project_count} project${org.project_count === 1 ? "" : "s"}. Older entries are deleted every hour.${owner ? "" : " Only owners change it."}`}>
              <select id="retention" className="select" value={current} disabled={!owner} onChange={(e) => (shorter(e.target.value) ? setPending(e.target.value) : void apply(e.target.value).catch((x) => toast(errMsg(x))))}>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          </div>
        </section>
      )}
      <section className="panel">
        <div className="ph"><b>Organization log</b></div>
        <div className="pb stack">
          <p className="section-sub">Members, roles, projects, single sign-on, SCIM, sign-ins, exports and purges. Each project's own changes are in its Project settings, Audit logs; the Compliance exports tab exports both.</p>
          {!isAdmin(org) ? <p className="section-sub">Only owners and admins see the organization log.</p>
            : q.isError ? <div className="banner err" role="alert">{errMsg(q.error)}</div>
            : q.isLoading ? <div className="subtle">Loading…</div>
            : !rows.length ? <EmptyState title="Nothing yet" />
            : <DataTable rowKey={(r) => r.id} rows={rows} columns={[
              { key: "when", header: "When", render: (r) => fmt.dateTime(r.occurred_at) },
              { key: "what", header: "What", render: (r) => <>{label(r.action)}{r.action.endsWith("_failed") && <> <Tag tone="down">Failed</Tag></>}</> },
              { key: "who", header: "Who", render: (r) => <><Tag tone={r.actor.type === "user" ? "muted" : "info"}>{ACTOR[r.actor.type] ?? r.actor.type}</Tag> {r.actor.email ?? (r.actor.id ? <code>{r.actor.id}</code> : null)}</> },
              { key: "target", header: "Target", render: (r) => <><span className="subtle">{r.target.type.replace(/_/g, " ")} </span>{r.target.id && <code>{r.target.id}</code>}{typeof r.data.email === "string" && <span className="subtle"> {r.data.email}</span>}</> },
            ]} />}
          {q.hasNextPage && <button type="button" className="btn btn-line" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{q.isFetchingNextPage ? "Loading…" : "Load more"}</button>}
        </div>
      </section>
      {pending !== null && (
        <ConfirmDialog title="Shorten audit retention?" confirmLabel="Delete older entries" danger onClose={() => setPending(null)} onConfirm={() => apply(pending)}>
          Entries older than {options.find((o) => o.value === pending)?.label} are deleted within the hour, for the organization and every one of its projects. Export them first if you need them; this cannot be undone.
        </ConfirmDialog>
      )}
    </div>
  );
}
