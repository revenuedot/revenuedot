import { useState } from "react";
import { Link } from "react-router-dom";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { PageHead, Tag, useProjectId } from "../../components/ui";
import { useExports, useIntegrationTypes, useIntegrations, useWebhooks } from "./data";

/**
 * Integrations (/projects/:projectId/integrations): RevenueCat's catalogue (frame 27) with its category rail and counts.
 * Webhooks and Scheduled Data Exports are built in; every other card comes from the API catalogue
 * (GET …/integrations/catalog, prd/integrations/PRD.md), so a new partner appears here as soon as the server has it.
 * Partners that publish no event API of their own show "Via webhook".
 */

type Cat = "core" | "analytics" | "attribution" | "marketing" | "ads" | "support";
interface Integration { id: string; name: string; cat: Cat; text: string; to: string; via?: "webhook" }

const CATS: { id: Cat; label: string; text: string }[] = [
  { id: "core", label: "Core tools", text: "Connect RevenueDot to your own backend and data warehouse." },
  { id: "analytics", label: "Analytics", text: "See purchase events next to product usage." },
  { id: "attribution", label: "Attribution", text: "Tie revenue back to the ad campaigns that brought each customer." },
  { id: "marketing", label: "Marketing", text: "Message customers based on their plan and billing state." },
  { id: "ads", label: "Ads", text: "Ad revenue and rewarded ads next to subscription revenue." },
  { id: "support", label: "Support", text: "Show subscription details next to support conversations." },
];

const BUILT_IN: Integration[] = [
  { id: "webhooks", name: "Webhooks", cat: "core", text: "Send every purchase event to your own server as it happens, signed and retried.", to: "webhooks" },
  { id: "exports", name: "Scheduled Data Exports", cat: "core", text: "Daily or weekly CSV or Parquet files of transactions, customers and events in S3, R2 or Google Cloud Storage.", to: "exports" },
];

export function Integrations() {
  const pid = useProjectId();
  const hooks = useWebhooks(pid);
  const partners = useIntegrations(pid);
  const exports = useExports(pid);
  const types = useIntegrationTypes(pid);
  const CATALOG: Integration[] = [...BUILT_IN, ...(types.data ?? []).map((t) => ({ id: t.type, name: t.name, cat: (CATS.some((c) => c.id === t.category) ? t.category : "core") as Cat, text: t.description, to: t.type, via: t.api === "webhook" ? "webhook" as const : undefined }))]
    .sort((a, b) => (a.cat === b.cat ? (BUILT_IN.includes(a) ? -1 : BUILT_IN.includes(b) ? 1 : a.name.localeCompare(b.name)) : 0));
  const [cat, setCat] = useState<"all" | "active" | Cat>("all");
  const [q, setQ] = useState("");
  const activeCount = (i: Integration) => i.id === "webhooks" ? hooks.data?.length ?? 0 : i.id === "exports" ? exports.data?.length ?? 0 : partners.data?.filter((p) => p.type === i.id).length ?? 0;
  const active = (i: Integration) => activeCount(i) > 0;
  const shown = CATALOG.filter((i) =>
    (cat === "all" || (cat === "active" ? active(i) : i.cat === cat)) && (!q.trim() || `${i.name} ${i.text}`.toLowerCase().includes(q.trim().toLowerCase())));
  const count = (c: "all" | "active" | Cat) => c === "all" ? CATALOG.length : c === "active" ? CATALOG.filter(active).length : CATALOG.filter((i) => i.cat === c).length;

  const card = (i: Integration) => (
    <Link key={i.id} className="card" to={`/projects/${pid}/integrations/${i.to}`} data-integration={i.id}>
      <div className="card-h"><span className="mono-tile" aria-hidden>{i.name.slice(0, 2)}</span><b>{i.name}</b>
        {active(i) ? <Tag tone="up">Active · {activeCount(i)}</Tag> : <Tag tone="muted">Set up</Tag>}
      </div>
      <p>{i.text}</p>
      {i.via && <span className="cellsub">Via webhook</span>}
    </Link>
  );

  const groups = cat === "all" ? CATS.filter((c) => shown.some((i) => i.cat === c.id)) : [];
  return (
    <Shell title="Integrations">
      <div className="page">
        <PageHead title="Integrations" sub="Send purchase events to the tools you already use, and your data to your own bucket. Event names match RevenueCat's, so dashboards built on them keep working." />
        <div className="integ">
          <nav className="rail" aria-label="Integration categories">
            {([["all", "All categories"], ["active", "Active"], ...CATS.map((c) => [c.id, c.label])] as ["all" | "active" | Cat, string][]).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={cat === id} onClick={() => setCat(id)}>{label}<span className="num mono">{count(id)}</span></button>
            ))}
          </nav>
          <div className="stack">
            <div className="isearch">
              <Icon name="search" /><input aria-label="Search integrations" placeholder="Search integrations" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {!shown.length && <div className="empty"><h3>{cat === "active" ? "No active integrations yet" : "No integration matches"}</h3><p>{cat === "active" ? "Add a webhook, connect a tool, or set up a data export." : "Try another name."}</p>{cat === "active" && <Link className="btn btn-dark" to={`/projects/${pid}/integrations/webhooks/new`}>Add a webhook</Link>}</div>}
            {cat === "all"
              ? groups.map((g) => (
                <section key={g.id} className="stack tight" aria-labelledby={`cat-${g.id}`}>
                  <div className="group-h"><h2 id={`cat-${g.id}`}>{g.label}</h2><p>{g.text}</p></div>
                  <div className="cards">{shown.filter((i) => i.cat === g.id).map(card)}</div>
                </section>
              ))
              : !!shown.length && <div className="cards">{shown.map(card)}</div>}
          </div>
        </div>
      </div>
    </Shell>
  );
}
