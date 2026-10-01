import { useEffect, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "../../components/icons";
import { ConfirmDialog, CopyButton, Field, Sparkline, Switch, useToast } from "../../components/ui";
import { api, fmt } from "../../lib/api";
import { base, errMsg } from "../setup/data";
import { uploadImage, useMedia } from "../paywalls/lib";
import "./settings.css";

/**
 * Verified Metrics tab (prd/project-settings §4): the public page at /verified/<slug> on the API host. Status, slug with a
 * live availability check, display name, chart type, the order and visibility of the 6 overview metrics, the project
 * icon and store links, Publish and Unpublish, and a preview with the production numbers the page will show.
 */

type MetricId = "mrr" | "revenue" | "active_subscriptions" | "active_trials" | "new_customers" | "active_users";
interface Settings {
  object: "verified_metrics"; status: "never_published" | "published" | "inactive"; slug: string; display_name: string; chart_type: "number_sparkline";
  metrics: { id: MetricId; visible: boolean }[]; show_icon: boolean; icon_asset_id: string | null; show_store_links: boolean;
  app_store_url: string | null; play_store_url: string | null; url: string; published_at: number | null; updated_at: number | null;
}
const LABEL: Record<MetricId, [string, "$" | "#"]> = {
  mrr: ["MRR", "$"], revenue: ["Revenue", "$"], active_subscriptions: ["Active subscriptions", "#"], active_trials: ["Active trials", "#"],
  new_customers: ["New customers", "#"], active_users: ["Active customers", "#"],
};
const STATUS: Record<Settings["status"], string> = { never_published: "Never published", published: "Published", inactive: "Inactive" };
type Draft = Pick<Settings, "slug" | "display_name" | "chart_type" | "metrics" | "show_icon" | "icon_asset_id" | "show_store_links" | "app_store_url" | "play_store_url">;
const draftOf = (s: Settings): Draft => ({ slug: s.slug, display_name: s.display_name, chart_type: s.chart_type, metrics: s.metrics, show_icon: s.show_icon, icon_asset_id: s.icon_asset_id, show_store_links: s.show_store_links, app_store_url: s.app_store_url, play_store_url: s.play_store_url });

export function VerifiedMetricsTab({ pid }: { pid: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["verified", pid], enabled: !!pid, queryFn: () => api<Settings>(`${base(pid)}/verified_metrics`) });
  const [d, setD] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [error, setError] = useState<{ param?: string; message: string } | null>(null);
  const [unpublishing, setUnpublishing] = useState(false);
  const [slugState, setSlugState] = useState<{ slug: string; available: boolean; reason: string | null } | null>(null);
  const media = useMedia(pid);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { if (q.data) setD(draftOf(q.data)); }, [q.data]);
  // Live slug check, debounced.
  useEffect(() => {
    if (!d || !q.data || d.slug === q.data.slug) { setSlugState(null); return; }
    const t = setTimeout(async () => {
      try { setSlugState(await api(`${base(pid)}/verified_metrics/slug_availability?slug=${encodeURIComponent(d.slug)}`)); } catch { /* the save reports it */ }
    }, 300);
    return () => clearTimeout(t);
  }, [d?.slug, q.data, pid]);
  const overview = useQuery({ queryKey: ["overview", pid, "production"], enabled: !!pid, queryFn: () => api<{ metrics: { id: string; value: number }[] }>(`/v2/projects/${pid}/metrics/overview?environment=production`) });
  const histories = useQueries({ queries: (["mrr", "revenue", "active_subscriptions", "active_trials", "new_customers", "active_users"] as MetricId[]).map((id) => ({
    queryKey: ["verified-history", pid, id], enabled: !!pid,
    queryFn: () => api<{ values: { value: number }[] | null }>(`/v2/projects/${pid}/metrics/history?metric=${id}&days=28&environment=production`),
  })) });

  if (q.isError) return <div className="banner err" role="alert">Verified Metrics could not be loaded: {errMsg(q.error)}</div>;
  if (!q.data || !d) return <div className="panel pb subtle">Loading…</div>;
  const s = q.data;
  const dirty = JSON.stringify(d) !== JSON.stringify(draftOf(s));
  const set = (p: Partial<Draft>) => { setD({ ...d, ...p }); setError(null); };
  const move = (i: number, by: number) => { const m = [...d.metrics]; const [x] = m.splice(i, 1); m.splice(i + by, 0, x!); set({ metrics: m }); };
  const host = s.url.replace(/\/verified\/.*$/, "/verified/");
  const send = async (kind: "save" | "publish") => {
    setBusy(kind); setError(null);
    try {
      const r = await api<Settings>(`${base(pid)}/verified_metrics${kind === "publish" ? "/actions/publish" : ""}`, { method: "POST", json: { ...d, app_store_url: d.app_store_url || null, play_store_url: d.play_store_url || null } });
      qc.setQueryData(["verified", pid], r);
      toast(kind === "publish" ? (s.status === "published" ? "Changes published." : "Your page is live.") : "Saved.");
    } catch (e) {
      const body = (e as { body?: { param?: string } }).body;
      setError({ param: body?.param, message: errMsg(e) });
    } finally { setBusy(null); }
  };
  const valueOf = (id: MetricId) => overview.data?.metrics.find((m) => m.id === id)?.value ?? 0;
  const shown = d.metrics.filter((m) => m.visible);
  const images = media.data ?? [];
  const icon = images.find((a) => a.id === d.icon_asset_id);
  const live = s.status === "published";

  return (
    <div className="vm-layout">
      <div className="stack">
        <section className="panel">
          <div className="ph"><b>Verified Metrics</b><span className={`vm-status${live ? " live" : ""}`}><i />{STATUS[s.status]}</span></div>
          <div className="pb stack">
            <p className="section-sub">A public page with your production numbers, computed by RevenueDot from store receipts and notifications. It shows totals only: no customers, no sandbox data.</p>
            {live && <div className="hrow"><a className="btn btn-line" href={s.url} target="_blank" rel="noreferrer"><Icon name="link" />Open page</a><CopyButton value={s.url} label="Copy page URL" /></div>}
            <Field label="Share URL" htmlFor="vm-slug" hint={slugState && !slugState.available ? undefined : "3 to 40 characters: a-z, 0-9 and dashes."} error={error?.param === "slug" ? error.message : slugState && !slugState.available ? slugState.reason : null}>
              <div className="vm-url"><span>{host}</span><input id="vm-slug" value={d.slug} maxLength={40} spellCheck={false} onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/\s+/g, "-") })} /></div>
            </Field>
            <Field label="Display name" htmlFor="vm-name" error={error?.param === "display_name" ? error.message : null}>
              <input id="vm-name" className="input" maxLength={60} value={d.display_name} onChange={(e) => set({ display_name: e.target.value })} />
            </Field>
            <Field label="Chart type" htmlFor="vm-chart"><select id="vm-chart" className="select" value={d.chart_type} onChange={() => {}}><option value="number_sparkline">Number & sparklines</option></select></Field>
          </div>
        </section>

        <section className="panel">
          <div className="ph"><b>Metrics</b><span className="subtle">{shown.length} of 6 shown</span></div>
          <div className="pb">
            <ol className="vm-metrics" aria-label="Metric order and visibility">
              {d.metrics.map((m, i) => (
                <li key={m.id} className={m.visible ? "" : "off"}>
                  <b>{LABEL[m.id][0]}</b>
                  <button type="button" className="ib" aria-label={`Move ${LABEL[m.id][0]} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" /></button>
                  <button type="button" className="ib" aria-label={`Move ${LABEL[m.id][0]} down`} disabled={i === d.metrics.length - 1} onClick={() => move(i, 1)}><Icon name="down" /></button>
                  <Switch checked={m.visible} label={m.visible ? "Shown" : "Hidden"} onChange={(v) => set({ metrics: d.metrics.map((x) => (x.id === m.id ? { ...x, visible: v } : x)) })} />
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="panel">
          <div className="ph"><b>Project details</b></div>
          <div className="pb stack">
            <Switch checked={d.show_icon} onChange={(v) => set({ show_icon: v })} label="Show project icon" />
            {d.show_icon && (
              <div className="hrow">
                {icon && <img src={`${icon.asset_base_url}/${icon.object_name}`} alt="" width={40} height={40} style={{ border: "1px solid var(--border)", objectFit: "cover" }} />}
                <select className="select" aria-label="Project icon" style={{ maxWidth: 260 }} value={d.icon_asset_id ?? ""} onChange={(e) => set({ icon_asset_id: e.target.value || null })}>
                  <option value="">Choose an uploaded image…</option>
                  {images.map((a) => <option key={a.id} value={a.id}>{a.original_name}</option>)}
                </select>
                <button type="button" className="btn btn-line" onClick={() => file.current?.click()}>Upload</button>
                <input ref={file} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="Icon image" onChange={async (e) => {
                  const f = e.target.files?.[0]; if (!f) return;
                  try { const a = await uploadImage(pid, f); await qc.invalidateQueries({ queryKey: ["paywall-media", pid] }); set({ icon_asset_id: a.id }); } catch (err) { toast(errMsg(err)); }
                }} />
              </div>
            )}
            <Switch checked={d.show_store_links} onChange={(v) => set({ show_store_links: v })} label="Show store links" />
            {d.show_store_links && <>
              <Field label="App Store URL" htmlFor="vm-ios" error={error?.param === "app_store_url" ? error.message : null}><input id="vm-ios" className="input mono" placeholder="https://apps.apple.com/app/id…" value={d.app_store_url ?? ""} onChange={(e) => set({ app_store_url: e.target.value })} /></Field>
              <Field label="Google Play URL" htmlFor="vm-play" error={error?.param === "play_store_url" ? error.message : null}><input id="vm-play" className="input mono" placeholder="https://play.google.com/store/apps/details?id=…" value={d.play_store_url ?? ""} onChange={(e) => set({ play_store_url: e.target.value })} /></Field>
            </>}
          </div>
        </section>

        {error && !["slug", "display_name", "app_store_url", "play_store_url"].includes(error.param ?? "") && <div className="banner err" role="alert">{error.message}</div>}
        <div className="hrow">
          <button type="button" className="btn btn-dark" disabled={!!busy || (!dirty && live)} onClick={() => send("publish")}>{busy === "publish" ? "Publishing…" : live ? "Publish changes" : "Publish"}</button>
          {!live && <button type="button" className="btn btn-line" disabled={!!busy || !dirty} onClick={() => send("save")}>{busy === "save" ? "Saving…" : "Save draft"}</button>}
          {live && <button type="button" className="btn btn-line" disabled={!!busy} onClick={() => setUnpublishing(true)}>Unpublish</button>}
          {dirty && <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={() => { setD(draftOf(s)); setError(null); }}>Discard</button>}
          {s.published_at && <span className="subtle">Last published {fmt.dateTime(s.published_at)}</span>}
        </div>
      </div>

      <aside className="vm-preview" aria-label="Preview">
        <div className="vm-ph"><Icon name="globe" />{host}{d.slug}</div>
        <div className="vm-pb">
          <span className="vm-status live"><i />Verified by RevenueDot</span>
          <h3>{d.display_name || "Your app"}</h3>
          {shown.length ? (
            <div className="vm-cells">
              {shown.map((m) => {
                const i = (["mrr", "revenue", "active_subscriptions", "active_trials", "new_customers", "active_users"] as MetricId[]).indexOf(m.id);
                const v = valueOf(m.id);
                return (
                  <div key={m.id}>
                    <div className="l">{LABEL[m.id][0]}</div>
                    <div className="v">{LABEL[m.id][1] === "$" ? fmt.usd(v) : fmt.int(v)}</div>
                    <Sparkline values={(histories[i]?.data?.values ?? []).map((p) => p.value)} />
                  </div>
                );
              })}
            </div>
          ) : <p className="subtle">Turn on at least one metric.</p>}
          {d.show_store_links && (d.app_store_url || d.play_store_url) && <div className="hrow" style={{ marginTop: 12 }}>{d.app_store_url && <span className="btn btn-line">App Store</span>}{d.play_store_url && <span className="btn btn-line">Google Play</span>}</div>}
          <p className="subtle" style={{ marginTop: 12, fontSize: 12 }}>Production numbers right now. The public page refreshes every 15 minutes.</p>
        </div>
      </aside>
      {unpublishing && <ConfirmDialog title="Unpublish your page?" confirmLabel="Unpublish" onClose={() => setUnpublishing(false)} onConfirm={async () => {
        const r = await api<Settings>(`${base(pid)}/verified_metrics/actions/unpublish`, { method: "POST" });
        qc.setQueryData(["verified", pid], r);
        toast("Your page is offline.");
      }}>{s.url} stops answering at once. Links shared before show a "not found" page. You can publish again later with the same URL.</ConfirmDialog>}
    </div>
  );
}
