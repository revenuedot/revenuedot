/**
 * Paywalls: /projects/:projectId/paywalls (list, new) and /paywalls/:paywallId (editor).
 * A paywall belongs to one offering. The editor builds the paywall components the RevenueCat SDKs render (RevenueCatUI
 * PaywallView, Paywalls V2) from a template form, shows a preview, saves the draft and publishes it. The SDK only ever
 * receives the published version.
 * GAPS vs RevenueCat's paywall builder: no free-form drag-and-drop canvas, no tabs, carousels, timelines or countdowns,
 * no localization editor beyond the default locale.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { buildPaywall, type PaywallTemplateInput } from "@revenuedot/core";
import { api, fmt, type List } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { ConfirmDialog, DataTable, Dialog, Disclosure, EmptyState, Field, Menu, PageHead, Segmented, Tag, useProjectId, useToast, type MenuItem } from "../../components/ui";
import { Icon } from "../../components/icons";
import { errMsg, v2, type Offering } from "../catalog/lib";

interface Version { revision: number | null; components_config: Record<string, unknown> | null; components_localizations: Record<string, Record<string, string>>; default_locale: string | null }
interface Paywall {
  object: "paywall"; id: string; name: string | null; offering_id: string | null; created_at: number; published_at: number | null; revision: number;
  offering?: Offering | null; components?: { published: Version | null; draft: Version | null };
}

const status = (p: Paywall): [string, "up" | "gold" | "muted"] =>
  p.published_at ? (p.components?.draft ? ["Published, with changes", "gold"] : ["Published", "up"]) : ["Not published", "muted"];

const usePaywalls = (pid: string) => useQuery({
  queryKey: ["paywalls", pid], enabled: !!pid,
  queryFn: async () => {
    const list = await api<List<Paywall>>(`${v2(pid)}/paywalls?limit=100&expand=items.offering`);
    // The list has no components; fetch them to tell "published with changes" apart.
    return Promise.all(list.items.map((p) => api<Paywall>(`${v2(pid)}/paywalls/${p.id}?expand=components&expand=offering`)));
  },
});
const useOfferingsWithPackages = (pid: string) => useQuery({ queryKey: ["paywall-offerings", pid], enabled: !!pid, queryFn: async () => (await api<List<Offering>>(`${v2(pid)}/offerings?limit=100&expand=items.package`)).items });

export function PaywallsPage() {
  const pid = useProjectId();
  const nav = useNavigate();
  const toast = useToast();
  const pws = usePaywalls(pid);
  const offs = useOfferingsWithPackages(pid);
  const [creating, setCreating] = useState(false);
  const [offering, setOffering] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const free = (offs.data ?? []).filter((o) => !(pws.data ?? []).some((p) => p.offering_id === o.id));
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const p = await api<Paywall>(`${v2(pid)}/paywalls`, { method: "POST", json: { offering_id: offering || free[0]!.id } });
      toast("Paywall created"); nav(`/projects/${pid}/paywalls/${p.id}`);
    } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  const rows = (pws.data ?? []).slice().sort((a, b) => b.created_at - a.created_at);
  return (
    <Shell title="Paywalls">
      <div className="page">
        <PageHead title="Paywalls" sub="Native paywalls your app shows with RevenueCatUI's PaywallView. Change them here without an app release."
          actions={<button type="button" className="btn btn-dark" onClick={() => setCreating(true)}><Icon name="plus" />New paywall</button>} />
        {pws.isError ? <div className="banner err" role="alert">Paywalls could not be loaded: {errMsg(pws.error)}</div> : pws.isLoading ? <div className="panel pb subtle">Loading…</div> : !rows.length ? (
          <EmptyState title="No paywalls yet" text="Pick an offering, choose a template, write the headline and features, and publish. Apps that show PaywallView pick it up on the next launch."
            action={<button type="button" className="btn btn-dark" onClick={() => setCreating(true)}>New paywall</button>} />
        ) : (
          <DataTable rowKey={(p) => p.id} rows={rows} onRowClick={(p) => nav(`/projects/${pid}/paywalls/${p.id}`)} columns={[
            { key: "name", header: "Name", render: (p) => p.name ?? <span className="subtle">Untitled</span> },
            { key: "offering", header: "Offering", render: (p) => p.offering ? <code>{p.offering.lookup_key}</code> : <span className="subtle">None</span> },
            { key: "status", header: "Status", render: (p) => { const [t, tone] = status(p); return <Tag tone={tone}>{t}</Tag>; } },
            { key: "published", header: "Published", render: (p) => fmt.date(p.published_at) },
          ]} />
        )}
      </div>
      {creating && (
        <Dialog title="New paywall" onClose={() => setCreating(false)} footer={<>
          <button type="button" className="btn btn-line" onClick={() => setCreating(false)}>Cancel</button>
          <button type="button" className="btn btn-dark" disabled={busy || !free.length} onClick={create}>{busy ? "Creating…" : "Create"}</button>
        </>}>
          {!free.length ? <p className="muted" style={{ margin: 0 }}>Every offering already has a paywall. <Link className="ul" to={`/projects/${pid}/product-catalog/offerings`}>Create an offering</Link> first.</p> : (
            <Field label="Offering" htmlFor="pw-offering" hint="The paywall shows this offering's packages. Each offering has one paywall.">
              <select id="pw-offering" className="select" value={offering || free[0]!.id} onChange={(e) => setOffering(e.target.value)}>
                {free.map((o) => <option key={o.id} value={o.id}>{o.display_name} ({o.lookup_key})</option>)}
              </select>
            </Field>
          )}
          {err && <div className="banner err" role="alert">{err}</div>}
        </Dialog>
      )}
    </Shell>
  );
}

type Form = Omit<PaywallTemplateInput, "packages" | "features"> & { features: string; labels: Record<string, string> };
const DEFAULT_FORM: Form = { template: "classic", headline: "Unlock everything", subheadline: "Try it free, cancel anytime.", features: "Unlimited access\nNo ads\nSync across devices", cta: "Continue", restoreLabel: "Restore purchases", accentColor: "#f7b500", backgroundColor: "#ffffff", textColor: "#111111", labels: {} };
const TEMPLATES: { value: PaywallTemplateInput["template"]; label: string }[] = [{ value: "classic", label: "Classic" }, { value: "hero", label: "Hero image" }, { value: "minimal", label: "Minimal" }];

export function PaywallEditor() {
  const pid = useProjectId();
  const { paywallId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const pw = useQuery({ queryKey: ["paywall", pid, paywallId], queryFn: () => api<Paywall>(`${v2(pid)}/paywalls/${paywallId}?expand=components&expand=offering`), enabled: !!paywallId });
  const tpl = useQuery({ queryKey: ["paywall-template", pid, paywallId], queryFn: () => api<{ template: Form | null }>(`${v2(pid)}/paywalls/${paywallId}/template`), enabled: !!paywallId });
  const offs = useOfferingsWithPackages(pid);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "unpublish" | null>(null);

  useEffect(() => { if (tpl.data && !form) setForm({ ...DEFAULT_FORM, ...(tpl.data.template ?? {}) }); }, [tpl.data, form]);
  const offering = offs.data?.find((o) => o.id === pw.data?.offering_id);
  const packages = (offering?.packages?.items ?? []).map((p) => ({ id: p.lookup_key, label: form?.labels[p.lookup_key] ?? p.display_name }));
  const input: PaywallTemplateInput | null = form ? { ...form, features: form.features.split("\n").map((f) => f.trim()).filter(Boolean), packages } : null;
  const built = useMemo(() => (input ? buildPaywall(input) : null), [JSON.stringify(input)]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async (publish: boolean) => {
    if (!form || !built || !pw.data) return;
    if (!form.headline.trim()) { setErr("Write a headline."); return; }
    if (publish && !packages.length) { setErr("The offering has no packages. Add packages to it before publishing."); return; }
    setBusy(publish ? "publish" : "save"); setErr(null);
    try {
      await api(`${v2(pid)}/paywalls/${paywallId}`, { method: "PATCH", json: { revision: pw.data.revision, components_config: built.components_config, components_localizations: built.components_localizations, default_locale: built.default_locale, name: pw.data.name ?? form.headline } });
      await api(`${v2(pid)}/paywalls/${paywallId}/template`, { method: "PUT", json: { template: form } });
      if (publish) await api(`${v2(pid)}/paywalls/${paywallId}/actions/publish`, { method: "POST" });
      await qc.invalidateQueries({ queryKey: ["paywall", pid, paywallId] }); await qc.invalidateQueries({ queryKey: ["paywalls", pid] });
      toast(publish ? "Published. Apps get it on their next offerings fetch." : "Draft saved");
    } catch (e) { setErr(errMsg(e)); }
    setBusy(null);
  };
  const upload = async (file: File) => {
    if (file.size > 2_000_000) { setErr("Images must be under 2 MB."); return; }
    setBusy("upload"); setErr(null);
    try {
      const b64 = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] ?? ""); r.onerror = () => no(r.error); r.readAsDataURL(file); });
      const a = await api<{ asset_base_url: string; object_name: string }>(`${v2(pid)}/media_assets`, { method: "POST", json: { filename: file.name, content_type: file.type || "image/png", file_data_base64: b64 } });
      set("imageUrl", `${a.asset_base_url}/${a.object_name}`);
    } catch (e) { setErr(errMsg(e)); }
    setBusy(null);
  };

  const p = pw.data;
  const menu: (MenuItem | "-")[] = [
    { label: "Duplicate", icon: "copy", onSelect: async () => { const d = await api<Paywall>(`${v2(pid)}/paywalls/${paywallId}/actions/duplicate`, { method: "POST", json: {} }); toast("Duplicated"); nav(`/projects/${pid}/paywalls/${d.id}`); } },
    ...(p?.published_at ? [{ label: "Unpublish", icon: "archive", onSelect: () => setConfirm("unpublish") } as MenuItem] : []),
    "-", { label: "Delete", icon: "trash", danger: true, onSelect: () => setConfirm("delete") },
  ];
  let body: ReactNode;
  if (pw.isError) body = <div className="banner err" role="alert">The paywall could not be loaded: {errMsg(pw.error)}</div>;
  else if (!p || !form) body = <div className="panel pb subtle">Loading…</div>;
  else body = (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 340px)", gap: 24, alignItems: "start" }} className="pw-grid">
      <div className="panel pb" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Segmented label="Template" value={form.template} options={TEMPLATES} onChange={(v) => set("template", v)} />
        <Field label="Headline" htmlFor="pw-head"><input id="pw-head" className="input" value={form.headline} onChange={(e) => set("headline", e.target.value)} /></Field>
        <Field label="Subheadline" htmlFor="pw-sub"><input id="pw-sub" className="input" value={form.subheadline ?? ""} onChange={(e) => set("subheadline", e.target.value)} /></Field>
        {form.template !== "minimal" && <Field label="Features" htmlFor="pw-feat" hint="One per line."><textarea id="pw-feat" className="input" rows={4} value={form.features} onChange={(e) => set("features", e.target.value)} /></Field>}
        {form.template === "hero" && (
          <Field label="Hero image" htmlFor="pw-img" hint={form.imageUrl ? <span className="mono">{form.imageUrl.split("/").pop()}</span> : "PNG, JPEG or WebP, under 2 MB."}>
            <input id="pw-img" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          </Field>
        )}
        <div>
          <div className="label">Packages</div>
          {!packages.length ? <p className="subtle" style={{ margin: "4px 0 0" }}>{offering ? <>The offering <code>{offering.lookup_key}</code> has no packages. <Link className="ul" to={`/projects/${pid}/product-catalog/offerings/${offering.id}`}>Add packages</Link>.</> : "Attach the paywall to an offering."}</p>
            : packages.map((k) => (
              <div key={k.id} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                <code style={{ minWidth: 110 }}>{k.id}</code>
                <input aria-label={`Label for ${k.id}`} className="input" value={k.label} onChange={(e) => set("labels", { ...form.labels, [k.id]: e.target.value })} />
                <label className="subtle" style={{ whiteSpace: "nowrap" }}><input type="radio" name="pw-sel" checked={(form.selectedPackage ?? packages[0]?.id) === k.id} onChange={() => set("selectedPackage", k.id)} /> Selected</label>
              </div>
            ))}
        </div>
        <Field label="Button text" htmlFor="pw-cta"><input id="pw-cta" className="input" value={form.cta ?? ""} onChange={(e) => set("cta", e.target.value)} /></Field>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {(["accentColor", "backgroundColor", "textColor"] as const).map((k) => (
            <Field key={k} label={k === "accentColor" ? "Accent" : k === "backgroundColor" ? "Background" : "Text"} htmlFor={`pw-${k}`}>
              <input id={`pw-${k}`} type="color" value={form[k] ?? "#000000"} onChange={(e) => set(k, e.target.value)} />
            </Field>
          ))}
        </div>
        <Disclosure title="Components JSON" sub="What the SDK receives after you publish">
          <pre className="mono" style={{ maxHeight: 280, overflow: "auto", fontSize: 11 }} aria-label="Components JSON">{JSON.stringify(built, null, 2)}</pre>
        </Disclosure>
        {err && <div className="banner err" role="alert">{err}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-line" disabled={!!busy} onClick={() => save(false)}>{busy === "save" ? "Saving…" : "Save draft"}</button>
          <button type="button" className="btn btn-dark" disabled={!!busy || !p.offering_id} onClick={() => save(true)}>{busy === "publish" ? "Publishing…" : "Publish"}</button>
        </div>
      </div>
      <Preview input={input!} />
    </div>
  );
  return (
    <Shell title={p?.name ?? "Paywall"} crumbs={<><Link className="cat-crumb-up" to={`/projects/${pid}/paywalls`}>Paywalls</Link> <span className="cat-crumb-up">/</span> <b className="cat-crumb">{p?.name ?? "Paywall"}</b></>}>
      <div className="page">
        <PageHead title={p?.name ?? "Paywall"} sub={p ? <>{p.offering ? <>Offering <code>{p.offering.lookup_key}</code>. </> : "No offering. "}{(() => { const [t, tone] = status(p); return <Tag tone={tone}>{t}</Tag>; })()}</> : undefined}
          actions={p ? <Menu label="Paywall actions" items={menu} /> : undefined} />
        {body}
      </div>
      {confirm === "delete" && <ConfirmDialog title="Delete this paywall?" confirmLabel="Delete paywall" danger onClose={() => setConfirm(null)} onConfirm={async () => {
        await api(`${v2(pid)}/paywalls/${paywallId}`, { method: "DELETE" }); await qc.invalidateQueries({ queryKey: ["paywalls", pid] }); toast("Paywall deleted"); nav(`/projects/${pid}/paywalls`);
      }}><p>Apps stop showing it on their next offerings fetch. This cannot be undone.</p></ConfirmDialog>}
      {confirm === "unpublish" && <ConfirmDialog title="Unpublish this paywall?" confirmLabel="Unpublish" danger onClose={() => setConfirm(null)} onConfirm={async () => {
        await api(`${v2(pid)}/paywalls/${paywallId}/actions/unpublish`, { method: "POST" }); await qc.invalidateQueries({ queryKey: ["paywall", pid, paywallId] }); toast("Unpublished");
      }}><p>Apps stop receiving it. Your content stays as a draft.</p></ConfirmDialog>}
    </Shell>
  );
}

/** An approximation of how RevenueCatUI lays the template out on a phone. Prices show as placeholders. */
function Preview({ input }: { input: PaywallTemplateInput }) {
  const bg = input.backgroundColor ?? "#ffffff", fg = input.textColor ?? "#111111", accent = input.accentColor ?? "#f7b500";
  const sel = input.selectedPackage ?? input.packages[0]?.id;
  return (
    <figure aria-label="Paywall preview" style={{ margin: 0, position: "sticky", top: 16 }}>
      <div style={{ width: "100%", maxWidth: 320, aspectRatio: "9 / 19", borderRadius: 36, border: "8px solid #111", background: bg, color: fg, overflow: "hidden", display: "flex", flexDirection: "column", marginInline: "auto" }}>
        <div style={{ flex: 1, overflow: "auto", padding: "24px 18px", display: "flex", flexDirection: "column", gap: 14, textAlign: "center" }}>
          {input.template === "hero" && (input.imageUrl ? <img src={input.imageUrl} alt="" style={{ width: "calc(100% + 36px)", margin: "-24px -18px 0", height: 160, objectFit: "cover" }} /> : <div style={{ height: 120, background: "#0002", borderRadius: 8 }} aria-hidden />)}
          <div style={{ fontSize: input.template === "minimal" ? 20 : 24, fontWeight: 700 }}>{input.headline || "Headline"}</div>
          {input.subheadline && <div style={{ opacity: 0.65, fontSize: 14 }}>{input.subheadline}</div>}
          {input.template !== "minimal" && (input.features ?? []).length > 0 && <div style={{ textAlign: "left", display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>{(input.features ?? []).map((f, i) => <div key={i}>✓&nbsp; {f}</div>)}</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {input.packages.map((p) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "12px 14px", borderRadius: 12, border: p.id === sel ? `2px solid ${accent}` : `1px solid ${fg}33`, fontSize: 14 }}>
                <b>{p.label}</b><span style={{ opacity: 0.8 }}>$–.– / period</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ padding: "12px 18px 18px", display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
          <div style={{ width: "100%", textAlign: "center", padding: "12px 0", borderRadius: 999, background: accent, fontWeight: 600, color: "#111" }}>{input.cta || "Continue"}</div>
          <div style={{ fontSize: 12, opacity: 0.6 }}>{input.restoreLabel || "Restore purchases"}</div>
        </div>
      </div>
      <figcaption className="subtle" style={{ textAlign: "center", marginTop: 8, fontSize: 12 }}>Preview. Prices come from the store on the device.</figcaption>
    </figure>
  );
}
