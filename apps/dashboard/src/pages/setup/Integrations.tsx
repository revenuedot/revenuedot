import { useState } from "react";
import { Link } from "react-router-dom";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { PageHead, Tag, useProjectId } from "../../components/ui";
import { useExports, useIntegrations, useWebhooks } from "./data";

/**
 * Integrations (/projects/:projectId/integrations): RevenueCat's catalogue (frame 27) with its category rail and counts.
 * Webhooks, Scheduled Data Exports and ten partner integrations work (prd/integrations/PRD.md); the rest are marked "Soon".
 * GAPS vs RevenueCat: mParticle, Branch, Singular, Apple Search Ads, Braze, Customer.io, OneSignal, Intercom and Zendesk.
 * RevenueCat also has an "Ads" category (AdMob), listed in the Marketing group here.
 */

type Cat = "core" | "analytics" | "attribution" | "marketing" | "support";
interface Integration { id: string; name: string; cat: Cat; text: string; to?: string }

const CATS: { id: Cat; label: string; text: string }[] = [
  { id: "core", label: "Core tools", text: "Connect RevenueDot to your own backend and data warehouse." },
  { id: "analytics", label: "Analytics", text: "See purchase events next to product usage." },
  { id: "attribution", label: "Attribution", text: "Tie revenue back to the ad campaigns that brought each customer." },
  { id: "marketing", label: "Marketing", text: "Message customers based on their plan and billing state." },
  { id: "support", label: "Support", text: "Show subscription details next to support conversations." },
];

const CATALOG: Integration[] = [
  { id: "webhooks", name: "Webhooks", cat: "core", text: "Send every purchase event to your own server as it happens, signed and retried.", to: "webhooks" },
  { id: "exports", name: "Scheduled Data Exports", cat: "core", text: "Daily or weekly CSV or Parquet files of transactions, customers and events in S3, R2 or Google Cloud Storage.", to: "exports" },
  { id: "bigquery", name: "BigQuery", cat: "core", text: "Every event as a row in a BigQuery table, streamed as it happens.", to: "bigquery" },
  { id: "amplitude", name: "Amplitude", cat: "analytics", text: "Subscription events and revenue next to your product analytics.", to: "amplitude" },
  { id: "mixpanel", name: "Mixpanel", cat: "analytics", text: "Add subscription status and revenue to Mixpanel profiles.", to: "mixpanel" },
  { id: "posthog", name: "PostHog", cat: "analytics", text: "Revenue events for funnels, retention and session replays.", to: "posthog" },
  { id: "segment", name: "Segment", cat: "analytics", text: "Send purchase events to every destination in your workspace.", to: "segment" },
  { id: "mparticle", name: "mParticle", cat: "analytics", text: "Route purchase events through your customer data platform." },
  { id: "firebase", name: "Firebase", cat: "analytics", text: "Purchase events in Google Analytics for Firebase.", to: "firebase" },
  { id: "adjust", name: "Adjust", cat: "attribution", text: "Report purchases and renewals to Adjust.", to: "adjust" },
  { id: "appsflyer", name: "AppsFlyer", cat: "attribution", text: "Report purchases and renewals to AppsFlyer.", to: "appsflyer" },
  { id: "branch", name: "Branch", cat: "attribution", text: "Report purchases to Branch for link attribution." },
  { id: "singular", name: "Singular", cat: "attribution", text: "Subscription revenue in your marketing ROI reports." },
  { id: "apple-ads", name: "Apple Search Ads", cat: "attribution", text: "Match purchases to Apple Search Ads campaigns and keywords." },
  { id: "meta", name: "Meta Ads", cat: "attribution", text: "Send purchase conversions to Meta for campaign optimization.", to: "meta" },
  { id: "braze", name: "Braze", cat: "marketing", text: "Trigger messages from subscription events." },
  { id: "customerio", name: "Customer.io", cat: "marketing", text: "Segment and message customers by plan." },
  { id: "onesignal", name: "OneSignal", cat: "marketing", text: "Push notifications based on subscription status." },
  { id: "slack", name: "Slack", cat: "marketing", text: "Post new purchases and cancellations to a channel.", to: "slack" },
  { id: "intercom", name: "Intercom", cat: "support", text: "Subscription details in the Intercom inbox." },
  { id: "zendesk", name: "Zendesk", cat: "support", text: "Subscription details next to Zendesk tickets." },
];

export function Integrations() {
  const pid = useProjectId();
  const hooks = useWebhooks(pid);
  const partners = useIntegrations(pid);
  const exports = useExports(pid);
  const [cat, setCat] = useState<"all" | "active" | Cat>("all");
  const [q, setQ] = useState("");
  const activeCount = (i: Integration) => i.id === "webhooks" ? hooks.data?.length ?? 0 : i.id === "exports" ? exports.data?.length ?? 0 : partners.data?.filter((p) => p.type === i.id).length ?? 0;
  const active = (i: Integration) => activeCount(i) > 0;
  const shown = CATALOG.filter((i) =>
    (cat === "all" || (cat === "active" ? active(i) : i.cat === cat)) && (!q.trim() || `${i.name} ${i.text}`.toLowerCase().includes(q.trim().toLowerCase())));
  const count = (c: "all" | "active" | Cat) => c === "all" ? CATALOG.length : c === "active" ? CATALOG.filter(active).length : CATALOG.filter((i) => i.cat === c).length;

  const card = (i: Integration) => {
    const inner = (
      <>
        <div className="card-h"><span className="mono-tile" aria-hidden>{i.name.slice(0, 2)}</span><b>{i.name}</b>
          {i.to ? (active(i) ? <Tag tone="up">Active · {activeCount(i)}</Tag> : <Tag tone="muted">Set up</Tag>) : <span className="soon">SOON</span>}
        </div>
        <p>{i.text}</p>
      </>
    );
    return i.to
      ? <Link key={i.id} className="card" to={`/projects/${pid}/integrations/${i.to}`}>{inner}</Link>
      : <div key={i.id} className="card" aria-disabled="true">{inner}</div>;
  };

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
