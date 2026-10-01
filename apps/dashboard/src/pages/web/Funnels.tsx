/**
 * Funnels and Purchase Links (/projects/:projectId/funnels, prd/web-billing/PRD.md §3 and §5). Funnels: the list (status,
 * public URL, views and purchases over 30 days) or an empty state, and "Create web funnel" from the starter funnel, a blank
 * one, or "Build with AI". Purchase links: one checkout link per offering, with an optional automatic discount and expiry.
 * RevenueCat's equivalent: frame 15 of the contact sheet.
 */
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { Check, ConfirmDialog, CopyButton, Dialog, Field, Menu, PageHead, Tag, useProjectId, useToast, type MenuItem } from "../../components/ui";
import { api, fmt } from "../../lib/api";
import { useOfferings, v2 } from "../catalog/lib";
import { DropButton } from "../paywalls/Paywalls";
import { Pictogram, apiError } from "./parts";
import { dateInput, endOfDay, useFunnelAi, useFunnels, usePurchaseLinks, useRefreshWeb, useWeb, useWebDiscounts, type Funnel, type FunnelSummary, type PurchaseLink } from "./lib";

type Start = "starter" | "blank" | "ai";

export function FunnelsPage() {
  const pid = useProjectId();
  const nav = useNavigate();
  const funnels = useFunnels(pid);
  const links = usePurchaseLinks(pid);
  const ai = useFunnelAi(pid);
  const web = useWeb(pid);
  const [start, setStart] = useState<Start | null>(null);
  const [linkDialog, setLinkDialog] = useState<PurchaseLink | "new" | null>(null);
  const noStripe = web.data && !web.data.providers.length;
  const createItems = [
    { label: "Start from the starter funnel", icon: "layers", onSelect: () => setStart("starter") },
    { label: "Blank", icon: "plus", onSelect: () => setStart("blank") },
    ...(ai.data?.available ? [{ label: "Build with AI", icon: "spark", onSelect: () => setStart("ai") }] : []),
  ];
  const fRows = (funnels.data ?? []).slice().sort((a, b) => b.updated_at - a.updated_at);
  const lRows = (links.data ?? []).slice().sort((a, b) => b.created_at - a.created_at);

  return (
    <Shell title="Funnels and Purchase Links">
      <div className="page">
        <PageHead title="Funnels and Purchase Links" sub="Sell on the web with checkout pages RevenueDot hosts on your Stripe account. Build a multi-step web-to-app funnel, or share a simple checkout link for any offering." />
        {noStripe && (
          <div className="banner warn" role="status"><Icon name="warn" /><span style={{ flex: 1 }}>Connect Stripe before your pages can take payments.</span><Link className="btn btn-line" to={`/projects/${pid}/web`}>Set up web payments</Link></div>
        )}

        <div className="group-h wb-group">
          <div><h2>Funnels</h2><p>Multi-step web-to-app flows that turn web visitors into paying customers.</p></div>
          {!!fRows.length && <DropButton label="Create web funnel" items={createItems} />}
        </div>
        {funnels.isError ? <div className="banner err" role="alert">Funnels could not be loaded: {apiError(funnels.error).message}</div>
          : funnels.isLoading ? <div className="panel pb subtle">Loading…</div>
          : !fRows.length ? (
            <section className="panel wb-empty" aria-label="Create a funnel">
              <div className="wb-empty-h">
                <Pictogram kind="funnel" />
                <h3>No funnels yet</h3>
                <p>Build a multi-step web-to-app flow: a few questions, an email, your offer, and a page that opens the app.</p>
                <DropButton label="Create web funnel" items={createItems} />
              </div>
              <div className="wb-feats">
                <div><span className="pw-start-i"><Icon name="globe" /></span><h4>Acquire customers on the web</h4><p>Capture attribution from ads, qualify visitors with questions, and take payment before they install your app.</p></div>
                <div><span className="pw-start-i"><Icon name="spark" /></span><h4>Build with AI and test every step</h4><p>Start from a prompt, then edit copy, offers and paths with a live preview of every step.</p></div>
                <div><span className="pw-start-i"><Icon name="integrations" /></span><h4>Keep every signal connected</h4><p>Funnel and purchase events go to your webhooks and analytics tools, with the visitor's UTM parameters.</p></div>
              </div>
            </section>
          ) : (
            <div className="panel tbl">
              <table aria-label="Funnels">
                <thead><tr><th>Name</th><th>Status</th><th>URL</th><th className="amt">Views (30d)</th><th className="amt">Purchases (30d)</th><th>Updated</th></tr></thead>
                <tbody>
                  {fRows.map((f) => <FunnelRow key={f.id} f={f} onOpen={() => nav(`/projects/${pid}/funnels/${f.id}`)} />)}
                </tbody>
              </table>
            </div>
          )}

        <div className="group-h wb-group">
          <div><h2>Purchase Links</h2><p>A checkout link for any offering: the quickest way to start taking payments on the web.</p></div>
          {!!lRows.length && <button type="button" className="btn btn-dark" onClick={() => setLinkDialog("new")}><Icon name="plus" />Create purchase link</button>}
        </div>
        {links.isError ? <div className="banner err" role="alert">Purchase links could not be loaded: {apiError(links.error).message}</div>
          : links.isLoading ? <div className="panel pb subtle">Loading…</div>
          : !lRows.length ? (
            <section className="panel wb-empty" aria-label="Create a purchase link">
              <div className="wb-empty-h">
                <Pictogram kind="link" />
                <h3>No purchase links yet</h3>
                <p>Pick an offering and get a link to a hosted checkout with its packages. Add <code>?app_user_id=</code> to buy for a signed-in user.</p>
                <button type="button" className="btn btn-dark" onClick={() => setLinkDialog("new")}><Icon name="plus" />Create purchase link</button>
              </div>
            </section>
          ) : <LinksTable pid={pid} rows={lRows} onEdit={(l) => setLinkDialog(l)} />}
      </div>
      {start && <NewFunnelDialog pid={pid} start={start} onClose={() => setStart(null)} />}
      {linkDialog && <LinkDialog pid={pid} link={linkDialog === "new" ? null : linkDialog} onClose={() => setLinkDialog(null)} />}
    </Shell>
  );
}

function FunnelRow({ f, onOpen }: { f: FunnelSummary; onOpen: () => void }) {
  return (
    <tr className="row" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onOpen(); }}>
      <td><b>{f.name}</b><span className="cellsub">{f.steps} step{f.steps === 1 ? "" : "s"}</span></td>
      <td><span className="hrow"><Tag tone={f.status === "published" ? "up" : "muted"}>{f.status === "published" ? "Published" : "Draft"}</Tag>{f.has_unpublished_changes && <Tag tone="gold">Changes</Tag>}</span></td>
      <td className="url"><span className="hrow" onClick={(e) => e.stopPropagation()}><span className="wb-url" title={f.url}>{f.url}</span><CopyButton value={f.url} label={`Copy ${f.name} URL`} /></span></td>
      <td className="amt">{fmt.int(f.views_30d ?? 0)}</td>
      <td className="amt">{fmt.int(f.purchases_30d ?? 0)}</td>
      <td className="subtle">{fmt.ago(f.updated_at)}</td>
    </tr>
  );
}

function LinksTable({ pid, rows, onEdit }: { pid: string; rows: PurchaseLink[]; onEdit: (l: PurchaseLink) => void }) {
  const toast = useToast();
  const refresh = useRefreshWeb(pid);
  const [deleting, setDeleting] = useState<PurchaseLink | null>(null);
  const toggle = async (l: PurchaseLink) => {
    try { await api(`${v2(pid)}/purchase_links/${l.id}`, { method: "PATCH", json: { enabled: l.status === "disabled" } }); await refresh(); toast(l.status === "disabled" ? "Link enabled." : "Link disabled. It now shows an expired page."); }
    catch (e) { toast(apiError(e).message); }
  };
  const copy = async (text: string, msg: string) => { try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast("Copy failed. Select the text and copy it by hand."); } };
  return (
    <>
      <div className="panel tbl">
        <table aria-label="Purchase links">
          <thead><tr><th>Name</th><th>Offering</th><th>URL</th><th>Expires</th><th>Status</th><th className="amt">Checkouts / purchases</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {rows.map((l) => {
              const items: MenuItem[] = [
                { label: "Copy link", icon: "copy", onSelect: () => copy(l.url, "Link copied.") },
                { label: "Copy link for a signed-in user", icon: "userplus", onSelect: () => copy(`${l.url}?app_user_id={app_user_id}`, "Copied. Replace {app_user_id} with the customer's app user ID.") },
                { label: "Open link", icon: "arrow", onSelect: () => window.open(l.url, "_blank", "noopener") },
                { label: "Edit", icon: "edit", onSelect: () => onEdit(l) },
                { label: l.status === "disabled" ? "Enable" : "Disable", icon: l.status === "disabled" ? "play" : "archive", onSelect: () => toggle(l) },
                "-" as never,
                { label: "Delete", icon: "trash", danger: true, onSelect: () => setDeleting(l) },
              ];
              return (
                <tr key={l.id}>
                  <td><b>{l.name}</b><span className="cellsub mono">/{l.slug}</span></td>
                  <td>{l.offering_display_name ?? <span className="subtle">Deleted offering</span>}{l.offering_lookup_key && <span className="cellsub mono">{l.offering_lookup_key}</span>}</td>
                  <td className="url">
                    <span className="hrow"><a className="wb-url ul" href={l.url} target="_blank" rel="noreferrer" title={l.url}>{l.url}</a><CopyButton value={l.url} label={`Copy ${l.name} link`} /></span>
                    <span className="cellsub">Add <code>?app_user_id=</code> to buy for a signed-in user</span>
                  </td>
                  <td className="subtle">{l.expires_at ? fmt.date(l.expires_at) : "Never"}</td>
                  <td><Tag tone={l.status === "active" ? "up" : l.status === "expired" ? "down" : "muted"}>{l.status}</Tag></td>
                  <td className="amt">{l.checkouts} / {l.purchases}</td>
                  <td className="amt"><Menu label={`Actions for ${l.name}`} items={items} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {deleting && (
        <ConfirmDialog title={`Delete ${deleting.name}?`} confirmLabel="Delete link" danger onClose={() => setDeleting(null)} onConfirm={async () => {
          await api(`${v2(pid)}/purchase_links/${deleting.id}`, { method: "DELETE" }); await refresh(); toast("Purchase link deleted.");
        }}><p>The link stops working at once. Purchases made with it stay with their customers.</p></ConfirmDialog>
      )}
    </>
  );
}

function LinkDialog({ pid, link, onClose }: { pid: string; link: PurchaseLink | null; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshWeb(pid);
  const offs = useOfferings(pid);
  const discounts = useWebDiscounts(pid);
  const web = useWeb(pid);
  const withWeb = new Set(web.data?.offerings_with_web_products ?? []);
  const [name, setName] = useState(link?.name ?? "");
  const [offering, setOffering] = useState(link?.offering_id ?? "");
  const [slug, setSlug] = useState(link?.slug ?? "");
  const [discount, setDiscount] = useState(link?.discount_id ?? "");
  const [expires, setExpires] = useState(dateInput(link?.expires_at));
  const [enabled, setEnabled] = useState(link ? link.status !== "disabled" : true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; param: string | null } | null>(null);
  const offList = (offs.data ?? []).slice().sort((a, b) => Number(withWeb.has(b.id)) - Number(withWeb.has(a.id)));
  const chosen = offering || offList.find((o) => withWeb.has(o.id))?.id || offList[0]?.id || "";
  const fe = (k: string) => (err?.param === k ? err.message : null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr({ message: "Give the link a name, for example Spring sale.", param: "name" }); return; }
    if (!chosen) { setErr({ message: "Create an offering first.", param: "offering_id" }); return; }
    setBusy(true); setErr(null);
    const json = {
      name: name.trim(), offering_id: chosen, ...(slug.trim() ? { slug: slug.trim().toLowerCase() } : {}), discount_id: discount || null,
      expires_at: endOfDay(expires), ...(link ? { enabled } : {}),
    };
    try {
      const l = await api<PurchaseLink>(link ? `${v2(pid)}/purchase_links/${link.id}` : `${v2(pid)}/purchase_links`, { method: link ? "PATCH" : "POST", json });
      await refresh();
      toast(link ? "Purchase link saved." : `Link ready: ${l.url}`);
      onClose();
    } catch (x) { setErr(apiError(x)); setBusy(false); }
  };
  return (
    <Dialog title={link ? "Edit purchase link" : "Create purchase link"} onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" form="link-form" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : link ? "Save link" : "Create link"}</button>
    </>}>
      <form id="link-form" className="stack" onSubmit={save} noValidate>
        <Field label="Name" htmlFor="pl-name" error={fe("name")} hint="Only you see it. The page shows the offering's name.">
          <input id="pl-name" className="input" maxLength={120} placeholder="Spring sale" value={name} aria-invalid={!!fe("name")} onChange={(e) => { setName(e.target.value); setErr(null); }} />
        </Field>
        <Field label="Offering" htmlFor="pl-offering" error={fe("offering_id")} hint={chosen && !withWeb.has(chosen) ? "This offering has no web product yet, so the page cannot sell anything." : "The page shows this offering's packages with their web prices."}>
          <select id="pl-offering" className="select" value={chosen} onChange={(e) => setOffering(e.target.value)}>
            {offList.map((o) => <option key={o.id} value={o.id}>{o.display_name} ({o.lookup_key}){withWeb.has(o.id) ? "" : " · no web products"}</option>)}
          </select>
        </Field>
        <Field label="Address" htmlFor="pl-slug" error={fe("slug")} hint={`Optional. The end of the link: ${web.data?.project_base ?? ""}/${slug.trim() || "spring-sale"}`}>
          <input id="pl-slug" className="input mono" spellCheck={false} autoCapitalize="off" placeholder="made from the name" value={slug} aria-invalid={!!fe("slug")} onChange={(e) => { setSlug(e.target.value); setErr(null); }} />
        </Field>
        <Field label="Automatic discount" htmlFor="pl-discount" error={fe("discount_id")} hint="Optional. Applied without a code. Buyers can still enter a code instead.">
          <select id="pl-discount" className="select" value={discount} onChange={(e) => setDiscount(e.target.value)}>
            <option value="">None</option>
            {(discounts.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.customer_facing_name} · {d.label}</option>)}
          </select>
        </Field>
        <Field label="Expires" htmlFor="pl-expires" error={fe("expires_at")} hint="Optional. After this day the link shows an expired page.">
          <input id="pl-expires" className="input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
        {link && <Check checked={enabled} onChange={setEnabled} label="Enabled" hint="A disabled link shows an expired page." />}
        {err && !["name", "offering_id", "slug", "discount_id", "expires_at"].includes(err.param ?? "") && <div className="banner err" role="alert">{err.message}</div>}
      </form>
    </Dialog>
  );
}

const AI_EXAMPLES = [
  "A sleep app: ask about sleep goals and bedtime, then offer a 7-day free trial.",
  "A language app quiz: which language, current level, daily time. Yearly plan first.",
  "A fitness app for beginners with an email step before the paywall.",
];

function NewFunnelDialog({ pid, start, onClose }: { pid: string; start: Start; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const refresh = useRefreshWeb(pid);
  const ai = useFunnelAi(pid);
  const [name, setName] = useState(start === "blank" ? "New funnel" : start === "ai" ? "AI funnel" : "Onboarding funnel");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"gen" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr("Give the funnel a name."); return; }
    setErr(null);
    try {
      let draft: unknown;
      if (start === "ai") {
        if (prompt.trim().length < 3) { setErr("Describe the funnel in a few words."); return; }
        setBusy("gen");
        draft = (await api<{ draft: unknown }>(`${v2(pid)}/funnels/generate`, { method: "POST", json: { prompt: prompt.trim() } })).draft;
      }
      setBusy("save");
      const f = await api<Funnel>(`${v2(pid)}/funnels`, { method: "POST", json: { name: name.trim(), ...(draft ? { draft } : { template: start === "blank" ? "blank" : "starter" }) } });
      await refresh();
      toast(start === "ai" ? "Funnel created from the AI draft." : "Funnel created.");
      nav(`/projects/${pid}/funnels/${f.id}`);
    } catch (x) { setErr(apiError(x).message); setBusy(null); }
  };
  return (
    <Dialog title={start === "ai" ? "Build a funnel with AI" : start === "blank" ? "New blank funnel" : "New funnel from the starter"} onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose} disabled={!!busy}>Cancel</button>
      <button type="submit" form="new-funnel" className="btn btn-dark" disabled={!!busy}>{start === "ai" && <Icon name="spark" />}{busy === "gen" ? "Generating…" : busy === "save" ? "Creating…" : start === "ai" ? "Generate funnel" : "Create funnel"}</button>
    </>}>
      <form id="new-funnel" className="stack" onSubmit={create} noValidate>
        <Field label="Name" htmlFor="nf-name" hint="Also the end of the public address (you can change it later).">
          <input id="nf-name" className="input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {start === "starter" && <p className="section-sub">Five steps to edit: a question, an info page, an email step, the paywall with your current offering, and the success page.</p>}
        {start === "blank" && <p className="section-sub">The paywall and the success page. Add questions and info steps in the builder.</p>}
        {start === "ai" && (
          <>
            <Field label="Describe the funnel" htmlFor="nf-prompt" hint="Who it is for, the questions to ask, and the offer.">
              <textarea id="nf-prompt" className="textarea wb-prompt" rows={4} maxLength={ai.data?.max_prompt_length ?? 1000} placeholder={AI_EXAMPLES[0]} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </Field>
            <div className="pw-ai-ex">{AI_EXAMPLES.map((x) => <button key={x} type="button" className="chip" onClick={() => setPrompt(x)}>{x.split(":")[0]}</button>)}</div>
          </>
        )}
        {err && <div className="banner err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}
