/**
 * Offering detail: /projects/:projectId/product-catalog/offerings/:offeringId
 * Header facts, Packages / Metadata / Paywall tabs, per-app product rows, the metadata JSON editor and the REST API identifier.
 *
 * GAPS versus RevenueCat's dashboard (later tiers):
 * - "Paywall → Add Paywall", "Web Purchase Link" and "Targeting → Add Rules" rows are shown as coming later
 *   (Paywalls and Targeting are Tier 2, web purchase links Tier 3).
 */
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, fmt } from "../../lib/api";
import { Copy, Shell } from "../../components/Shell";
import { EmptyState, KeyValue, Menu, Tabs, Tag, useProjectId, useToast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { AppName, CatalogCrumbs, LoadError, LoadingRows, ProductCell } from "./parts";
import { DefaultTag, useOfferingActions } from "./Offerings";
import { MetadataEditor, metadataText, parseMetadata } from "./OfferingEditor";
import { catalogKey, errMsg, packageLabel, useApps, useOfferings, useRefreshCatalog, v2, type Offering } from "./lib";

type Tab = "packages" | "metadata";

export function OfferingDetail() {
  const pid = useProjectId();
  const { offeringId = "" } = useParams();
  const nav = useNavigate();
  const base = `/projects/${pid}/product-catalog`;
  const q = useQuery({ queryKey: [...catalogKey(pid), "offering", offeringId], queryFn: () => api<Offering>(`${v2(pid)}/offerings/${offeringId}?expand=package.product`) });
  const apps = useApps(pid);
  const all = useOfferings(pid);
  const actions = useOfferingActions(pid, all.data ?? (q.data ? [q.data] : []), { onDeleted: () => nav(`${base}/offerings`) });
  const [tab, setTab] = useState<Tab>("packages");
  const o = q.data;
  const notFound = q.error instanceof ApiError && q.error.status === 404;

  return (
    <Shell title={o?.lookup_key ?? "Offering"} crumbs={<CatalogCrumbs pid={pid} section="Offerings" sectionTo="offerings" current={o?.lookup_key ?? "…"} />}>
      <div className="page cat-detail">
        {notFound ? <EmptyState title="Offering not found" text="It may have been deleted." action={<Link className="btn btn-line" to={`${base}/offerings`}>Back to offerings</Link>} />
          : q.isError ? <LoadError error={q.error} retry={() => q.refetch()} />
          : !o ? <LoadingRows label="Loading offering" rows={5} /> : (
          <>
            <div className="head">
              <div className="cat-titlerow"><h1>{o.lookup_key}</h1>{o.is_current && <DefaultTag />}{o.state === "inactive" && <Tag>Inactive</Tag>}</div>
              <div className="actions">
                <Menu label="More actions" items={actions.items(o, false)} />
                <button type="button" className="btn btn-danger" onClick={() => actions.ask("delete", o)}><Icon name="trash" />Delete</button>
                <Link className="btn btn-dark" to={`${base}/offerings/${o.id}/edit`}><Icon name="edit" />Edit</Link>
              </div>
            </div>
            {o.is_current
              ? <div className="cat-defaultbar"><span className="live" /><span className="cat-d" style={{ color: "var(--fg-2)" }}>This is the <b style={{ color: "var(--fg)" }}>default offering</b>. The SDK returns it as <code>offerings.current</code> to every customer without an override.</span></div>
              : o.state === "active" && <div className="cat-note">Apps get this offering with <code>offerings["{o.lookup_key}"]</code>. It is not the default.</div>}
            <KeyValue rows={[
              ["Identifier", <Copy key="i" value={o.lookup_key} />],
              ["Display name", o.display_name],
              ["Status", o.state === "active" ? <Tag tone="up">Active</Tag> : <Tag>Inactive</Tag>],
              ["Created", <span key="c" className="mono">{fmt.dateTime(o.created_at)}</span>],
              ["Paywall", o.paywall_id ? <Link key="p" to={`/projects/${pid}/paywalls/${o.paywall_id}`}>Edit paywall</Link> : <Link key="p" to={`/projects/${pid}/paywalls/templates`}>Create a paywall</Link>],
              ["Web purchase link", <Link key="w" to={`/projects/${pid}/web`}>Purchase links on the Web page</Link>],
              ["Targeting", <Link key="t" to={`/projects/${pid}/targeting`}>Targeting rules</Link>],
            ]} />
            <Tabs label="Offering sections" idBase="od" value={tab} onChange={setTab}
              tabs={[{ value: "packages", label: "Packages" }, { value: "metadata", label: "Metadata" }]} />
            {tab === "packages" && (
              <div role="tabpanel" id="od-packages-panel" aria-labelledby="od-packages" className="cat-pkgs">
                <p className="cat-lead">Packages set which product each app offers. An app only sees packages that have a product for it.</p>
                {!o.packages?.items.length ? (
                  <EmptyState title="No packages" text="The SDK returns this offering with no packages. Add a package for each plan you sell." action={<Link className="btn btn-dark" to={`${base}/offerings/${o.id}/edit`}><Icon name="plus" />Add packages</Link>} />
                ) : [...o.packages.items].sort((a, b) => a.position - b.position).map((p) => {
                  const items = p.products?.items ?? [];
                  const appIds = [...new Set([...(apps.data ?? []).map((a) => a.id), ...items.map((x) => x.product.app_id)])];
                  return (
                    <section key={p.id} className="cat-pkg cat-pkg-view" aria-label={`Package ${p.lookup_key}`}>
                      <div className="cat-nm">{p.display_name}</div>
                      <div className="cat-pid">{p.lookup_key}<span className="subtle"> · {packageLabel(p.lookup_key)}</span></div>
                      {!items.length && <p className="cat-note" style={{ margin: "8px 0 0" }}>No products are attached to this package, so no app shows it.</p>}
                      {items.length > 0 && (
                        <ul>
                          {appIds.map((aid) => {
                            const app = apps.data?.find((a) => a.id === aid);
                            const prods = items.filter((x) => x.product.app_id === aid);
                            return (
                              <li key={aid}>
                                <AppName app={app} />
                                {prods.length ? <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>{prods.map((x) => (
                                  <span key={x.product.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                    <ProductCell p={x.product} to={`${base}/products/${x.product.id}`} />
                                    {x.eligibility_criteria !== "all" && <Tag tone="info">{x.eligibility_criteria === "google_sdk_lt_6" ? "SDK < 6" : "SDK ≥ 6"}</Tag>}
                                    {x.product.state === "inactive" && <Tag>Inactive</Tag>}
                                  </span>
                                ))}</span> : <span className="cat-miss">No product. {app?.name ?? "This app"} does not show this package.</span>}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
            {tab === "metadata" && <div role="tabpanel" id="od-metadata-panel" aria-labelledby="od-metadata"><MetadataPanel pid={pid} o={o} /></div>}
            <div className="cat-apiid"><b>REST API identifier</b><Copy value={o.id} /></div>
          </>
        )}
      </div>
      {actions.dialog}
    </Shell>
  );
}

function MetadataPanel({ pid, o }: { pid: string; o: Offering }) {
  const toast = useToast();
  const refresh = useRefreshCatalog(pid);
  const saved = metadataText(o.metadata);
  const [text, setText] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = text !== saved;
  const save = async () => {
    const pm = parseMetadata(text);
    if (pm.error) { setError(pm.error); return; }
    setBusy(true); setError(null);
    try {
      await api(`${v2(pid)}/offerings/${o.id}`, { method: "POST", json: { metadata: pm.value } });
      await refresh();
      toast("Metadata saved");
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <MetadataEditor id="od-meta" value={text} onChange={(v) => { setText(v); setError(null); }} error={error} />
      <div className="actions" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn btn-line" disabled={!dirty || busy} onClick={() => { setText(saved); setError(null); }}>Reset</button>
        <button type="button" className="btn btn-dark" disabled={!dirty || busy || !!parseMetadata(text).error} onClick={save}>{busy ? "Saving…" : "Save metadata"}</button>
      </div>
    </div>
  );
}
