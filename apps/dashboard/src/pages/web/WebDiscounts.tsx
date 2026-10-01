/**
 * Web discounts (/projects/:projectId/web-discounts, Product catalog ▸ Web discounts; prd/web-billing/PRD.md §6).
 * Discounts that apply automatically (a purchase link's or a funnel paywall's discount) or with a code at checkout. Each
 * one is a Stripe coupon and each code a promotion code in the developer's Stripe account. Creating one uses RevenueCat's
 * v2 operations with RevenueCat's field names (POST /discounts, then POST /discounts/:id/discount_codes); the list reads
 * RevenueDot's extension GET /web_discounts for the codes, redemptions and limits. RevenueCat's equivalent: frame 10.
 */
import { useState, type FormEvent } from "react";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { ConfirmDialog, Dialog, Field, Menu, PageHead, Segmented, Tag, useProjectId, useToast, type MenuItem } from "../../components/ui";
import { api, fmt } from "../../lib/api";
import { v2 } from "../catalog/lib";
import { Pictogram, apiError } from "./parts";
import { ELIGIBILITY, endOfDay, useRefreshWeb, useWeb, useWebDiscounts, useWebProducts, webPrice, type WebDiscount } from "./lib";

const STATUS_TONE: Record<WebDiscount["status"], "up" | "muted" | "down"> = { active: "up", disabled: "muted", expired: "down", used_up: "down" };
const STATUS_LABEL: Record<WebDiscount["status"], string> = { active: "Active", disabled: "Disabled", expired: "Expired", used_up: "Used up" };
const splitCodes = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

export function WebDiscountsPage() {
  const pid = useProjectId();
  const toast = useToast();
  const refresh = useRefreshWeb(pid);
  const list = useWebDiscounts(pid);
  const [creating, setCreating] = useState(false);
  const [codesFor, setCodesFor] = useState<WebDiscount | null>(null);
  const [deleting, setDeleting] = useState<WebDiscount | null>(null);
  const rows = (list.data ?? []).slice().sort((a, b) => b.created_at - a.created_at);
  const toggle = async (d: WebDiscount) => {
    const enable = d.status === "disabled";
    try { await api(`${v2(pid)}/discounts/${d.id}/actions/${enable ? "enable" : "disable"}`, { method: "POST" }); await refresh(); toast(enable ? "Discount enabled. Its codes work again." : "Discount disabled. Its codes stop working."); }
    catch (e) { toast(apiError(e).message); }
  };
  const create = <button type="button" className="btn btn-dark" onClick={() => setCreating(true)}><Icon name="plus" />Create discount</button>;
  return (
    <Shell title="Web discounts">
      <div className="page">
        <PageHead title="Web discounts" sub="Discounts for web checkout: applied automatically by a purchase link or funnel, or with a code. Each one is a coupon in your Stripe account." actions={rows.length ? create : undefined} />
        {list.isError ? <div className="banner err" role="alert">Discounts could not be loaded: {apiError(list.error).message}</div>
          : list.isLoading ? <div className="panel pb subtle">Loading…</div>
          : !rows.length ? (
            <section className="panel wb-empty" aria-label="Create a discount">
              <div className="wb-empty-h">
                <Pictogram kind="discount" />
                <h3>No discounts yet</h3>
                <p>Create discounts to apply automatically or with a code at checkout.</p>
                {create}
              </div>
            </section>
          ) : (
            <div className="panel tbl">
              <table aria-label="Discounts">
                <thead><tr><th>Name</th><th>Discount</th><th>Codes</th><th className="amt">Redemptions</th><th>Expires</th><th>Status</th><th aria-label="Actions" /></tr></thead>
                <tbody>
                  {rows.map((d) => {
                    const items: (MenuItem | "-")[] = [
                      { label: "Add codes", icon: "plus", onSelect: () => setCodesFor(d) },
                      { label: d.status === "disabled" ? "Enable" : "Disable", icon: d.status === "disabled" ? "play" : "archive", onSelect: () => toggle(d) },
                      "-", { label: "Delete", icon: "trash", danger: true, onSelect: () => setDeleting(d) },
                    ];
                    return (
                      <tr key={d.id}>
                        <td><b>{d.customer_facing_name}</b><span className="cellsub mono">{d.identifier}</span></td>
                        <td>{d.label}</td>
                        <td><span className="wb-codes">{d.codes.length ? d.codes.slice(0, 4).map((c) => <span key={c.code} className="wb-code mono">{c.code}</span>) : <span className="subtle">Automatic only</span>}{d.codes.length > 4 && <span className="subtle">+{d.codes.length - 4}</span>}</span></td>
                        <td className="amt">{d.times_redeemed}{d.max_redemptions ? ` / ${d.max_redemptions}` : ""}</td>
                        <td className="subtle">{d.expires_at ? fmt.date(d.expires_at) : "Never"}</td>
                        <td><Tag tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Tag></td>
                        <td className="amt"><Menu label={`Actions for ${d.customer_facing_name}`} items={items} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>
      {creating && <DiscountDialog pid={pid} onClose={() => setCreating(false)} />}
      {codesFor && <CodesDialog pid={pid} d={codesFor} onClose={() => setCodesFor(null)} />}
      {deleting && (
        <ConfirmDialog title={`Delete ${deleting.customer_facing_name}?`} confirmLabel="Delete discount" danger onClose={() => setDeleting(null)} onConfirm={async () => {
          await api(`${v2(pid)}/discounts/${deleting.id}`, { method: "DELETE" }); await refresh(); toast("Discount deleted.");
        }}><p>Its codes stop working and its Stripe coupon is deleted. Subscriptions that already use it keep their discount, as in Stripe.</p></ConfirmDialog>
      )}
    </Shell>
  );
}

function DiscountDialog({ pid, onClose }: { pid: string; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshWeb(pid);
  const web = useWeb(pid);
  const products = useWebProducts(pid, (web.data?.providers ?? []).map((p) => p.id));
  const [name, setName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [type, setType] = useState<"percentage" | "fixed_amount">("percentage");
  const [percent, setPercent] = useState("20");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [duration, setDuration] = useState<"one_time" | "time_window" | "forever">("one_time");
  const [months, setMonths] = useState("3");
  const [eligibility, setEligibility] = useState("everyone");
  const [productIds, setProductIds] = useState<string[]>([]);
  const [max, setMax] = useState("");
  const [expires, setExpires] = useState("");
  const [codes, setCodes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; param: string | null } | null>(null);
  const fe = (k: string) => (err?.param === k ? err.message : null);
  const autoId = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const bad = (message: string, param: string) => { setErr({ message, param }); };
    if (!name.trim()) return bad("Give the discount a name customers see, for example Spring sale.", "customer_facing_name");
    const ident = identifier.trim() || autoId(name);
    if (!/^[A-Za-z0-9_.-]+$/.test(ident)) return bad("Use letters, digits, _ . or - in the identifier.", "identifier");
    const body: Record<string, unknown> = { identifier: ident, customer_facing_name: name.trim(), type, duration_mode: duration, eligibility };
    if (type === "percentage") {
      const p = Number(percent);
      if (!Number.isInteger(p) || p < 1 || p > 100) return bad("A percentage is a whole number from 1 to 100.", "percentage");
      body.percentage = p;
    } else {
      const a = Number(amount);
      if (!amount.trim() || !Number.isFinite(a) || a <= 0) return bad("Enter an amount above zero, like 5.", "fixed_amounts");
      body.fixed_amounts = { [currency]: { currency, amount: a } };
    }
    if (duration === "time_window") {
      const m = Number(months);
      if (!Number.isInteger(m) || m < 1 || m > 36) return bad("Repeat for 1 to 36 months.", "time_window");
      body.time_window = `P${m}M`;
    }
    if (productIds.length) body.product_identifiers = productIds;
    if (max.trim()) {
      const m = Number(max);
      if (!Number.isInteger(m) || m < 1) return bad("Max redemptions is a whole number of 1 or more.", "max_redemptions");
      body.max_redemptions = m;
    }
    if (expires) body.expires_at = endOfDay(expires);
    const list = splitCodes(codes);
    if (list.some((c) => !/^[A-Za-z0-9_-]+$/.test(c))) return bad("Codes use letters, digits, _ and - only.", "codes");
    setBusy(true);
    let created: { id: string } | null = null;
    try {
      created = await api<{ id: string }>(`${v2(pid)}/discounts`, { method: "POST", json: body });
      if (list.length) await api(`${v2(pid)}/discounts/${created.id}/discount_codes`, { method: "POST", json: { codes: list } });
      await refresh();
      toast(list.length ? `Discount created with ${list.length} code${list.length === 1 ? "" : "s"}.` : "Discount created.");
      onClose();
    } catch (x) {
      const a = apiError(x);
      // The discount exists; only its codes failed. Keep the dialog for the codes' message, then close on the next save.
      if (created) { await refresh(); setErr({ message: `The discount was created, but the codes were not: ${a.message}`, param: "codes" }); setBusy(false); return; }
      setErr(a); setBusy(false);
    }
  };
  return (
    <Dialog title="Create discount" onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" form="discount-form" className="btn btn-dark" disabled={busy}>{busy ? "Creating in Stripe…" : "Create discount"}</button>
    </>}>
      <form id="discount-form" className="stack" onSubmit={save} noValidate>
        <div className="cols">
          <Field label="Name" htmlFor="dc-name" error={fe("customer_facing_name")} hint="Customers see it at checkout.">
            <input id="dc-name" className="input" maxLength={255} placeholder="Spring sale" value={name} onChange={(e) => { setName(e.target.value); if (!idTouched) setIdentifier(autoId(e.target.value)); setErr(null); }} />
          </Field>
          <Field label="Identifier" htmlFor="dc-id" error={fe("identifier")} hint="For the API. Letters, digits, _ . -">
            <input id="dc-id" className="input mono" spellCheck={false} autoCapitalize="off" placeholder="spring_sale" value={identifier} onChange={(e) => { setIdentifier(e.target.value); setIdTouched(true); setErr(null); }} />
          </Field>
        </div>
        <div className="field"><span className="flabel">Type</span>
          <Segmented label="Discount type" value={type} onChange={(v) => { setType(v); setErr(null); }} options={[{ value: "percentage", label: "Percentage" }, { value: "fixed_amount", label: "Fixed amount" }]} />
        </div>
        {type === "percentage" ? (
          <Field label="Percent off" htmlFor="dc-percent" error={fe("percentage")}>
            <input id="dc-percent" className="input mono" inputMode="numeric" value={percent} onChange={(e) => { setPercent(e.target.value); setErr(null); }} />
          </Field>
        ) : (
          <div className="cols">
            <Field label="Amount off" htmlFor="dc-amount" error={fe("fixed_amounts")}>
              <input id="dc-amount" className="input mono" inputMode="decimal" placeholder="5" value={amount} onChange={(e) => { setAmount(e.target.value); setErr(null); }} />
            </Field>
            <Field label="Currency" htmlFor="dc-currency"><select id="dc-currency" className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>{["USD", "EUR", "GBP", "CAD", "AUD", "JPY"].map((c) => <option key={c}>{c}</option>)}</select></Field>
          </div>
        )}
        <div className="field"><span className="flabel">Duration</span>
          <Segmented label="Duration" value={duration} onChange={(v) => { setDuration(v); setErr(null); }} options={[{ value: "one_time", label: "First payment" }, { value: "time_window", label: "Several months" }, { value: "forever", label: "Every payment" }]} />
        </div>
        {duration === "time_window" && (
          <Field label="Months" htmlFor="dc-months" error={fe("time_window")} hint="Subscriptions get the discount on every payment in these months.">
            <input id="dc-months" className="input mono" inputMode="numeric" value={months} onChange={(e) => { setMonths(e.target.value); setErr(null); }} />
          </Field>
        )}
        <Field label="Who can use it" htmlFor="dc-elig" error={fe("eligibility")}>
          <select id="dc-elig" className="select" value={eligibility} onChange={(e) => setEligibility(e.target.value)}>{ELIGIBILITY.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
        </Field>
        <fieldset className="wc-sec">
          <legend className="flabel">Products</legend>
          {products.data?.length ? (
            <div className="wb-checks">
              {products.data.map((w) => (
                <label key={w.product.id} className="check">
                  <input type="checkbox" checked={productIds.includes(w.product.id)} onChange={(e) => setProductIds((ids) => (e.target.checked ? [...ids, w.product.id] : ids.filter((i) => i !== w.product.id)))} />
                  <span><b>{w.product.display_name ?? w.product.store_identifier}</b><small className="mono">{webPrice(w)}</small></span>
                </label>
              ))}
            </div>
          ) : <p className="section-sub">{products.isLoading ? "Loading…" : "No web products yet."}</p>}
          <span className="hint subtle">Optional. Without a choice it applies to every web product.</span>
        </fieldset>
        <div className="cols">
          <Field label="Max redemptions" htmlFor="dc-max" error={fe("max_redemptions")} hint="Optional. Across all codes.">
            <input id="dc-max" className="input mono" inputMode="numeric" placeholder="No limit" value={max} onChange={(e) => { setMax(e.target.value); setErr(null); }} />
          </Field>
          <Field label="Expires" htmlFor="dc-expires" error={fe("expires_at")} hint="Optional. The last day it can be used.">
            <input id="dc-expires" className="input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
        </div>
        <Field label="Codes" htmlFor="dc-codes" error={fe("codes")} hint="Optional. Separate codes with commas or new lines. Codes are not case sensitive. Leave empty for a discount that only applies automatically.">
          <textarea id="dc-codes" className="textarea" rows={3} placeholder={"SPRING20\nFRIENDS"} value={codes} onChange={(e) => { setCodes(e.target.value); setErr(null); }} />
        </Field>
        {err && !["customer_facing_name", "identifier", "percentage", "fixed_amounts", "time_window", "eligibility", "max_redemptions", "expires_at", "codes"].includes(err.param ?? "") && <div className="banner err" role="alert">{err.message}</div>}
      </form>
    </Dialog>
  );
}

function CodesDialog({ pid, d, onClose }: { pid: string; d: WebDiscount; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshWeb(pid);
  const [codes, setCodes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const list = splitCodes(codes);
    if (!list.length) { setErr("Enter at least one code."); return; }
    if (list.some((c) => !/^[A-Za-z0-9_-]+$/.test(c))) { setErr("Codes use letters, digits, _ and - only."); return; }
    setBusy(true); setErr(null);
    try { await api(`${v2(pid)}/discounts/${d.id}/discount_codes`, { method: "POST", json: { codes: list } }); await refresh(); toast(`${list.length} code${list.length === 1 ? "" : "s"} added.`); onClose(); }
    catch (x) { setErr(apiError(x).message); setBusy(false); }
  };
  const removeCode = async (code: string) => {
    setRemoving(code); setErr(null);
    try { await api(`${v2(pid)}/discounts/${d.id}/discount_codes/${encodeURIComponent(code)}`, { method: "DELETE" }); await refresh(); toast(`${code} removed.`); onClose(); }
    catch (x) { setErr(apiError(x).message); setRemoving(null); }
  };
  return (
    <Dialog title={`Codes for ${d.customer_facing_name}`} onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose} disabled={busy}>Close</button>
      <button type="submit" form="codes-form" className="btn btn-dark" disabled={busy}>{busy ? "Adding…" : "Add codes"}</button>
    </>}>
      <form id="codes-form" className="stack" onSubmit={save} noValidate>
        {!!d.codes.length && (
          <ul className="wb-codelist">
            {d.codes.map((c) => (
              <li key={c.code}><span className="mono">{c.code}</span><span className="subtle">{c.times_redeemed} redeemed</span>
                <button type="button" className="ib" aria-label={`Remove ${c.code}`} disabled={!!removing} onClick={() => removeCode(c.code)}><Icon name="trash" /></button></li>
            ))}
          </ul>
        )}
        <Field label="New codes" htmlFor="cd-codes" hint="Separate codes with commas or new lines.">
          <textarea id="cd-codes" className="textarea" rows={3} value={codes} onChange={(e) => { setCodes(e.target.value); setErr(null); }} />
        </Field>
        {err && <div className="banner err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}
