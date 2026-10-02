/*
 * Customer page: who the customer is, what they have access to, what they bought, and everything that happened.
 * Data: RevenueCat's v2 customer endpoints (customer with attributes, subscriptions, purchases, events, actions)
 * plus our /customer_summaries extension (revenue, entitlement sources, prices, offering override).
 *
 * GAPS versus RevenueCat's customer page (company/docs/research/revenuecat-tech/semantics.md §7.2; the page itself
 * was not captured in the contact sheets):
 * - Notes (10 Markdown notes per customer): later tier.
 * - Transfer purchases to another customer, and store actions (refund, cancel, extend or defer a subscription):
 *   need the transfer endpoint and store API calls; later tier.
 * - Per-event detail of which integrations fired: the raw event body is shown instead.
 * - Experiment enrollment is shown only as the current offering's source.
 * - Total spent is in USD only (no display-currency setting yet).
 */
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Shell } from "../components/Shell";
import { Icon } from "../components/icons";
import { ConfirmDialog, Dialog, EmptyState, EVENT_TONE, Field, Menu, Panel, Tag, useProjectId, useToast } from "../components/ui";
import { api, ApiError, fmt, type List } from "../lib/api";
import { listAll } from "./catalog/lib";
import {
  attributeLabel, durationWords, eventLabel, flag, isAnonymous, money, per, PERIOD_TYPE, relative, RENEWAL, storeLabel, SUB_STATUS,
  type Attribute, type Customer, type CustomerEvent, type CustomerSummary, type Entitlement, type Offering, type Product, type Purchase, type Subscription,
} from "../lib/customers";

const DAY = 86400_000;
/** "Oct 4" this year, "Oct 4, 2025" otherwise. */
const shortDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(new Date(ms).getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
const DURATIONS = [
  { value: "1d", label: "1 day", ms: DAY }, { value: "3d", label: "3 days", ms: 3 * DAY }, { value: "1w", label: "1 week", ms: 7 * DAY },
  { value: "1m", label: "1 month", months: 1 }, { value: "2m", label: "2 months", months: 2 }, { value: "3m", label: "3 months", months: 3 },
  { value: "6m", label: "6 months", months: 6 }, { value: "1y", label: "1 year", months: 12 }, { value: "life", label: "Lifetime", months: 1200 },
] as const;
const until = (d: (typeof DURATIONS)[number], from = Date.now()) => {
  if ("ms" in d) return from + d.ms;
  const x = new Date(from); x.setUTCMonth(x.getUTCMonth() + d.months); return x.getTime();
};

function useCustomerData(pid: string, id: string) {
  const P = `/v2/projects/${pid}`;
  const C = `${P}/customers/${encodeURIComponent(id)}`;
  return {
    customer: useQuery({ queryKey: ["customer", pid, id], queryFn: () => api<Customer>(`${C}?expand=attributes`), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2 }),
    summary: useQuery({ queryKey: ["customer_summary", pid, id], queryFn: async () => (await api<List<CustomerSummary>>(`${P}/customer_summaries?ids=${encodeURIComponent(id)}`)).items[0] ?? null }),
    subs: useQuery({ queryKey: ["customer_subs", pid, id], queryFn: () => api<List<Subscription>>(`${C}/subscriptions?limit=100`) }),
    purchases: useQuery({ queryKey: ["customer_purchases", pid, id], queryFn: () => api<List<Purchase>>(`${C}/purchases?limit=100`) }),
    entitlements: useQuery({ queryKey: ["entitlements", pid], queryFn: () => api<List<Entitlement>>(`${P}/entitlements?limit=100`) }),
    offerings: useQuery({ queryKey: ["offerings", pid], queryFn: () => api<List<Offering>>(`${P}/offerings?limit=100`) }),
    products: useQuery({ queryKey: ["products", pid], queryFn: () => api<List<Product>>(`${P}/products?limit=100`) }),
  };
}

function Loading({ lines = 3 }: { lines?: number }) {
  return <div className="pb" style={{ display: "grid", gap: 14 }} aria-busy="true">{Array.from({ length: lines }, (_, i) => <span key={i} className="sk line" style={{ width: `${88 - i * 14}%` }} />)}</div>;
}
function Failed({ error, retry }: { error: unknown; retry: () => void }) {
  return <div className="pb"><div className="banner err" role="alert" style={{ alignItems: "center" }}><span style={{ flex: 1 }}>{error instanceof Error ? error.message : "Could not load this."}</span><button type="button" className="btn btn-line" onClick={retry}>Retry</button></div></div>;
}
const Env = ({ env }: { env: string }) => (env === "sandbox" ? <Tag tone="info">Sandbox</Tag> : null);

/* ---------- Dialogs ---------- */

function GrantDialog({ pid, id, entitlements, onClose, onDone }: { pid: string; id: string; entitlements: Entitlement[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [ent, setEnt] = useState(entitlements[0]?.id ?? "");
  const [dur, setDur] = useState<(typeof DURATIONS)[number]["value"]>("1m");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = DURATIONS.find((x) => x.value === dur)!;
  const end = until(d);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api(`/v2/projects/${pid}/customers/${encodeURIComponent(id)}/actions/grant_entitlement`, { method: "POST", json: { entitlement_id: ent, expires_at: until(d) } });
      const name = entitlements.find((x) => x.id === ent)?.display_name ?? "Entitlement";
      onDone(`Granted ${name} ${dur === "life" ? "for life" : `until ${fmt.date(end)}`}.`);
    } catch (err) { setError(err instanceof ApiError ? err.message : "The grant failed."); setBusy(false); }
  };
  return (
    <Dialog title="Grant an entitlement" onClose={onClose} footer={<><button type="button" className="btn btn-line" onClick={onClose}>Cancel</button><button type="submit" form="grant-form" className="btn btn-dark" disabled={busy || !ent}>{busy ? "Granting…" : "Grant access"}</button></>}>
      <form id="grant-form" onSubmit={submit} style={{ display: "contents" }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Gives this customer access without a purchase, for support cases or giveaways. It runs alongside any store purchase and never charges the customer.</p>
        {!entitlements.length ? <div className="banner warn">This project has no entitlements. <Link className="ul" to={`/projects/${pid}/product-catalog/entitlements`}>Create one</Link> first.</div> : <>
          <Field label="Entitlement" htmlFor="grant-ent"><select id="grant-ent" className="select" value={ent} onChange={(e) => setEnt(e.target.value)}>{entitlements.map((x) => <option key={x.id} value={x.id}>{x.display_name} ({x.lookup_key})</option>)}</select></Field>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ marginBottom: 8, textTransform: "none", letterSpacing: 0, fontSize: 12, color: "var(--fg-2)" }}>Duration</legend>
            <div className="radio-row">{DURATIONS.map((x) => <label key={x.value}><input type="radio" name="grant-dur" value={x.value} checked={dur === x.value} onChange={() => setDur(x.value)} />{x.label}</label>)}</div>
          </fieldset>
          <p className="subtle" style={{ margin: 0, fontSize: 12 }}>Access ends{" "}{dur === "life" ? "never (100 years)" : <b className="mono" style={{ color: "var(--fg)" }}>{fmt.dateTime(end)}</b>}.</p>
        </>}
        {error && <div className="banner err" role="alert">{error}</div>}
      </form>
    </Dialog>
  );
}

function OfferingDialog({ pid, id, offerings, current, onClose, onDone }: { pid: string; id: string; offerings: Offering[]; current: string | null; onClose: () => void; onDone: (msg: string) => void }) {
  const [value, setValue] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const def = offerings.find((o) => o.is_current);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api(`/v2/projects/${pid}/customers/${encodeURIComponent(id)}/actions/assign_offering`, { method: "POST", json: { offering_id: value || null } });
      onDone(value ? `This customer now sees ${offerings.find((o) => o.id === value)?.display_name ?? "the offering"}.` : "Offering override removed.");
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not change the offering."); setBusy(false); }
  };
  return (
    <Dialog title="Offering override" onClose={onClose} footer={<><button type="button" className="btn btn-line" onClick={onClose}>Cancel</button><button type="submit" form="off-form" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : "Save"}</button></>}>
      <form id="off-form" onSubmit={submit} style={{ display: "contents" }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>The SDK returns this offering as current for this customer only, instead of the project's current offering.</p>
        <Field label="Offering" htmlFor="off-sel"><select id="off-sel" className="select" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">No override{def ? `: show the current offering (${def.display_name})` : ""}</option>
          {offerings.filter((o) => o.state !== "archived").map((o) => <option key={o.id} value={o.id}>{o.display_name} ({o.lookup_key}){o.is_current ? ", current" : ""}</option>)}
        </select></Field>
        {error && <div className="banner err" role="alert">{error}</div>}
      </form>
    </Dialog>
  );
}

function AttributeDialog({ pid, id, initial, onClose, onDone }: { pid: string; id: string; initial?: Attribute; onClose: () => void; onDone: (msg: string) => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [value, setValue] = useState(initial?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bad = name && !/^\$?[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name) ? "Start with a letter; use letters, digits, - and _ only; 40 characters at most." : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api(`/v2/projects/${pid}/customers/${encodeURIComponent(id)}/attributes`, { method: "POST", json: { attributes: [{ name, value: value === "" ? null : value }] } });
      onDone(value === "" ? `Removed ${name}.` : `Saved ${name}.`);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not save the attribute."); setBusy(false); }
  };
  return (
    <Dialog title={initial ? "Edit attribute" : "Set an attribute"} onClose={onClose} footer={<><button type="button" className="btn btn-line" onClick={onClose}>Cancel</button><button type="submit" form="attr-form" className="btn btn-dark" disabled={busy || !name || !!bad}>{busy ? "Saving…" : "Save"}</button></>}>
      <form id="attr-form" onSubmit={submit} style={{ display: "contents" }}>
        <Field label="Name" htmlFor="attr-name" error={bad} hint="Custom names, or a reserved one such as $email or $displayName."><input id="attr-name" className="input mono" value={name} onChange={(e) => setName(e.target.value.trim())} readOnly={!!initial} maxLength={41} required /></Field>
        <Field label="Value" htmlFor="attr-value" hint="Leave empty to remove the attribute. 500 characters at most."><input id="attr-value" className="input" value={value} onChange={(e) => setValue(e.target.value)} maxLength={500} /></Field>
        {error && <div className="banner err" role="alert">{error}</div>}
      </form>
    </Dialog>
  );
}

function DeleteDialog({ pid, id, onClose }: { pid: string; id: string; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  return (
    <ConfirmDialog title="Delete this customer?" confirmLabel="Delete customer" danger onClose={onClose}
      onConfirm={async () => {
        if (typed !== "DELETE") throw new Error("Type DELETE to confirm.");
        await api(`/v2/projects/${pid}/customers/${encodeURIComponent(id)}`, { method: "DELETE" });
        qc.removeQueries({ predicate: (q) => q.queryKey[1] === pid && String(q.queryKey[0]).startsWith("customer") });
        await qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === pid });
        toast(`Deleted ${id}.`);
        nav(`/projects/${pid}/customers`);
      }}>
      <p>This removes <code>{id}</code>, its aliases, attributes, purchases and history, in production and sandbox. It cannot be undone and satisfies a data erasure request.</p>
      <p>It does not cancel store subscriptions. If the app opens again, a new customer is created.</p>
      <Field label="Type DELETE to confirm" htmlFor="del-typed"><input id="del-typed" className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></Field>
    </ConfirmDialog>
  );
}

/* ---------- Sections ---------- */

function Timeline({ pid, id, entName, productName }: { pid: string; id: string; entName: (k: string) => string; productName: (storeId: string) => string }) {
  const first = useQuery({ queryKey: ["customer_events", pid, id], queryFn: () => api<List<CustomerEvent>>(`/v2/projects/${pid}/customers/${encodeURIComponent(id)}/events?limit=25`) });
  const [more, setMore] = useState<CustomerEvent[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const items = [...(first.data?.items ?? []), ...more];
  // The server does not send is_trial_conversion yet, so a RENEWAL right after a TRIAL period of the same chain counts as one.
  const converted = useMemo(() => {
    const out = new Set<string>();
    const lastPeriod = new Map<string, string>();
    for (const e of [...items].sort((a, b) => a.occurred_at - b.occurred_at)) {
      const chain = String(e.body.original_transaction_id ?? "");
      if (e.type === "RENEWAL" && (e.body.is_trial_conversion === true || lastPeriod.get(chain) === "TRIAL")) out.add(e.id);
      if (e.type === "INITIAL_PURCHASE" || e.type === "RENEWAL") lastPeriod.set(chain, String(e.body.period_type ?? ""));
    }
    return out;
  }, [items]);
  const cursor = next === undefined ? first.data?.next_page ?? null : next;
  const load = async () => {
    if (!cursor) return;
    setBusy(true);
    try { const r = await api<List<CustomerEvent>>(cursor); setMore((m) => [...m, ...r.items]); setNext(r.next_page); } finally { setBusy(false); }
  };
  return (
    <Panel title="Customer history" flush>
      {first.isError ? <Failed error={first.error} retry={() => first.refetch()} />
        : first.isLoading ? <Loading lines={4} />
        : !items.length ? <div className="pnote">No events yet. Purchases, renewals, cancellations and grants appear here as they happen.</div>
        : (
          <>
            <ol className="tl" aria-label="Events, newest first">
              {items.map((e) => {
                const b = e.body;
                const price = typeof b.price_in_purchased_currency === "number" ? money(b.price_in_purchased_currency as number, String(b.currency ?? "USD")) : null;
                const env = String(b.environment ?? "").toLowerCase();
                return (
                  <li key={e.id}>
                    <details>
                      <summary>
                        <i className={`mk ${EVENT_TONE[e.type] ?? "muted"}`} aria-hidden />
                        <div style={{ minWidth: 0 }}>
                          <b>{converted.has(e.id) ? "Converted from a trial" : eventLabel(e, entName)}</b>
                          <span className="dt">
                            <span className="mono">{e.type}</span>
                            {typeof b.product_id === "string" && !b.product_id.startsWith("rc_promo_") && <span>{productName(b.product_id)}</span>}
                            {typeof b.store === "string" && <span>{storeLabel(b.store.toLowerCase())}</span>}
                            {price && <span className="mono">{price}</span>}
                            {typeof b.period_type === "string" && b.period_type !== "NORMAL" && b.period_type !== "PROMOTIONAL" && <span>{PERIOD_TYPE[b.period_type.toLowerCase()] ?? b.period_type}</span>}
                            {env === "sandbox" && <Tag tone="info">Sandbox</Tag>}
                          </span>
                        </div>
                        <time dateTime={new Date(e.occurred_at).toISOString()} title={relative(e.occurred_at)}>{fmt.dateTime(e.occurred_at)}</time>
                      </summary>
                      <pre aria-label="Event body">{JSON.stringify(b, null, 2)}</pre>
                    </details>
                  </li>
                );
              })}
            </ol>
            {cursor && <div className="pfoot"><span>{items.length} events shown</span><button type="button" className="linkbtn" onClick={load} disabled={busy}>{busy ? "Loading…" : "Show older ↓"}</button></div>}
          </>
        )}
    </Panel>
  );
}

function Attributes({ attrs, onEdit, onAdd }: { attrs: Attribute[]; onEdit: (a: Attribute) => void; onAdd: () => void }) {
  const groups = useMemo(() => {
    const order = ["Contact", "Attribution", "Device", "Integrations", "Custom"];
    const m = new Map<string, (Attribute & { label: string; group: string })[]>();
    for (const a of attrs) { const l = attributeLabel(a.name); m.set(l.group, [...(m.get(l.group) ?? []), { ...a, label: l.label, group: l.group }]); }
    return order.filter((g) => m.has(g)).map((g) => [g, m.get(g)!] as const);
  }, [attrs]);
  return (
    <Panel title="Attributes" link={<button type="button" className="linkbtn" onClick={onAdd}>Set →</button>} flush>
      {!attrs.length ? <div className="pnote">No attributes. The SDK sets them with setAttributes, setEmail and the attribution helpers; you can also set one here.</div> : (
        <div className="attrs">
          {groups.map(([g, list]) => (
            <div key={g}>
              <div className="grp">{g}</div>
              <dl>
                {list.map((a) => (
                  <div key={a.name} style={{ display: "contents" }}>
                    <dt title={a.name}>{a.label}</dt>
                    <dd className={a.name.startsWith("$") && a.group !== "Contact" ? "mono" : undefined}>
                      <button type="button" className="ul" style={{ textAlign: "left" }} onClick={() => onEdit(a)} title={`Edit ${a.name} · updated ${fmt.dateTime(a.updated_at)}`}>{a.value}</button>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ---------- Page ---------- */

interface Balance { currency_code: string; balance: number; name: string }
interface Currency { code: string; name: string; state?: string }

/** In-app currency balances, with a manual credit or debit (support goodwill, corrections), as on RevenueCat's customer page. */
function Currencies({ pid, id, onDone }: { pid: string; id: string; onDone: (msg: string) => void }) {
  // Same key and shape (an array) as the In-app currencies page, which shares this cache.
  const currencies = useQuery({ queryKey: ["virtual-currencies", pid], queryFn: () => listAll<Currency>(`/v2/projects/${pid}/virtual_currencies`) });
  const balances = useQuery({ queryKey: ["customer-balances", pid, id], queryFn: () => api<List<Balance>>(`/v2/projects/${pid}/customers/${encodeURIComponent(id)}/virtual_currencies`) });
  const [open, setOpen] = useState(false);
  const list = currencies.data ?? [];
  if (!list.length) return null;
  const bal = (code: string) => balances.data?.items.find((b) => b.currency_code === code)?.balance ?? 0;
  return (
    <Panel title="In-app currencies" link={balances.data ? <button type="button" className="linkbtn" onClick={() => setOpen(true)}>Adjust →</button> : undefined} flush>
      {balances.isLoading ? <Loading lines={1} /> : balances.isError ? <Failed error={balances.error} retry={() => void balances.refetch()} /> : (
        <dl className="kvs">
          {list.map((cur) => <div key={cur.code} style={{ display: "contents" }}><dt>{cur.name} <span className="mono subtle" style={{ fontSize: 12 }}>{cur.code}</span></dt><dd className="mono">{fmt.int(bal(cur.code))}</dd></div>)}
        </dl>
      )}
      {open && <AdjustDialog pid={pid} id={id} currencies={list} balanceOf={bal} onClose={() => setOpen(false)} onDone={(m) => { setOpen(false); onDone(m); }} />}
    </Panel>
  );
}

function AdjustDialog({ pid, id, currencies, balanceOf, onClose, onDone }: { pid: string; id: string; currencies: Currency[]; balanceOf: (code: string) => number; onClose: () => void; onDone: (msg: string) => void }) {
  const [code, setCode] = useState(currencies[0]?.code ?? "");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = Number(amount);
  const valid = amount.trim() !== "" && Number.isInteger(n) && n !== 0;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) { setError("Enter a whole number other than 0: positive to credit, negative to debit."); return; }
    setBusy(true); setError(null);
    try {
      await api(`/v2/projects/${pid}/customers/${encodeURIComponent(id)}/virtual_currencies/transactions`, { method: "POST", json: { adjustments: { [code]: n } } });
      onDone(`${n > 0 ? "Credited" : "Debited"} ${fmt.int(Math.abs(n))} ${code}. New balance: ${fmt.int(balanceOf(code) + n)}.`);
    } catch (err) { setError(err instanceof ApiError ? err.message : "The adjustment failed."); setBusy(false); }
  };
  return (
    <Dialog title="Adjust a balance" onClose={onClose} footer={<><button type="button" className="btn btn-line" onClick={onClose}>Cancel</button><button type="submit" form="vc-form" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : "Save"}</button></>}>
      <form id="vc-form" onSubmit={submit} style={{ display: "contents" }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Credit or debit this customer's balance by hand, for example as a support goodwill gesture. A balance never goes below zero.</p>
        <Field label="Currency" htmlFor="vc-code"><select id="vc-code" className="select" value={code} onChange={(e) => setCode(e.target.value)}>{currencies.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.code}): {fmt.int(balanceOf(c.code))}</option>)}</select></Field>
        <Field label="Amount" htmlFor="vc-amount" hint="Positive credits, negative debits."><input id="vc-amount" className="input mono" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 100 or -50" /></Field>
        {error && <div className="banner err" role="alert">{error}</div>}
      </form>
    </Dialog>
  );
}

export function CustomerDetail() {
  const pid = useProjectId();
  const id = useParams().appUserId ?? "";
  const qc = useQueryClient();
  const toast = useToast();
  const d = useCustomerData(pid, id);
  const [dialog, setDialog] = useState<null | { kind: "grant" } | { kind: "offering" } | { kind: "attr"; attr?: Attribute } | { kind: "delete" } | { kind: "revoke"; ent: CustomerSummary["granted_entitlements"][number] }>(null);
  const refresh = async (msg?: string) => {
    setDialog(null);
    if (msg) toast(msg);
    await qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === pid });
  };

  const c = d.customer.data;
  const s = d.summary.data;
  const ents = d.entitlements.data?.items ?? [];
  const entName = (k: string) => ents.find((e) => e.lookup_key === k)?.display_name ?? k;
  const products = d.products.data?.items ?? [];
  const productById = (pidv: string | null) => products.find((p) => p.id === pidv);
  const productName = (storeId: string) => products.find((p) => p.store_identifier === storeId)?.display_name ?? storeId;
  const offerings = d.offerings.data?.items ?? [];
  const currentOffering = offerings.find((o) => o.is_current);

  if (d.customer.isError) {
    const missing = d.customer.error instanceof ApiError && d.customer.error.status === 404;
    return (
      <Shell title="Customer" crumbs={<><Link to={`/projects/${pid}/customers`}>Customers</Link> <span>/</span> <b className="mono">{id}</b></>}>
        <div className="page narrow">
          {missing ? <EmptyState title="Customer not found" text={`No customer in this project has the app user ID or alias "${id}". It may have been deleted, or it belongs to another project.`} action={<Link className="btn btn-line" to={`/projects/${pid}/customers`}>Back to customers</Link>} />
            : <Failed error={d.customer.error} retry={() => d.customer.refetch()} />}
        </div>
      </Shell>
    );
  }

  const platform = c?.last_seen_platform ? (c.last_seen_platform.toLowerCase() === "ios" ? "iOS" : c.last_seen_platform[0]!.toUpperCase() + c.last_seen_platform.slice(1)) : null;
  const country = s?.country ?? c?.last_seen_country ?? null;
  const subs = d.subs.data?.items ?? [];
  const purchases = d.purchases.data?.items ?? [];
  const extra = (subId: string) => s?.subscriptions.find((x) => x.id === subId);
  const grants = s?.granted_entitlements ?? [];

  const moreItems = [
    { label: "Offering override", icon: "catalog", onSelect: () => setDialog({ kind: "offering" }) },
    { label: "Set an attribute", icon: "edit", onSelect: () => setDialog({ kind: "attr" }) },
    "-" as const,
    { label: "Delete customer", icon: "trash", danger: true, onSelect: () => setDialog({ kind: "delete" }) },
  ];

  const stat = (label: string, v: ReactNode, title?: string) => <div title={title}><span className="label">{label}</span><b>{v}</b></div>;

  return (
    <Shell title={id} crumbs={<><Link to={`/projects/${pid}/customers`}>Customers</Link> <span>/</span> <b className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240 }}>{id}</b></>}>
      <div className="page">
        <div className="cust-h">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="crumbs"><Link to={`/projects/${pid}/customers`}>← All customers</Link></div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <h1>{id}</h1>
              <Copy value={id} label="" />
            </div>
            <div className="meta">
              {isAnonymous(id) && <span className="soon" style={{ marginLeft: 0 }} title="Anonymous ID created by the SDK before log in">ANONYMOUS</span>}
              {s?.blocked && <Tag tone="down">Blocked</Tag>}
              {country && <span><span className="flag" aria-hidden>{flag(country)}</span>{country}</span>}
              {platform && <span>{platform}{c?.last_seen_app_version ? ` · app ${c.last_seen_app_version}` : ""}</span>}
              {c && <span>Customer since {fmt.date(c.first_seen_at)}</span>}
              {c?.last_seen_at && <span>Last seen {relative(c.last_seen_at)}</span>}
            </div>
          </div>
          <div className="actions">
            <button type="button" className="btn btn-dark" onClick={() => setDialog({ kind: "grant" })} disabled={!c}><Icon name="plus" />Grant entitlement</button>
            <Menu label="More customer actions" items={moreItems} />
          </div>
        </div>

        <div className="stats" aria-label="Customer summary">
          {stat("Total spent", s ? money(s.total_revenue_in_usd) : <span className="sk line" style={{ width: 80, height: 18 }} />, "Production revenue across all aliases, in USD, minus refunds")}
          {stat("Sandbox spent", s ? money(s.sandbox_revenue_in_usd) : "—", "Test Store and sandbox purchases. Not counted in revenue.")}
          {stat("Active entitlements", s ? String(s.active_entitlements.length) : "—")}
          {stat("First seen", c ? fmt.date(c.first_seen_at) : "—", c ? fmt.dateTime(c.first_seen_at) : undefined)}
          {stat("Last seen", c?.last_seen_at ? relative(c.last_seen_at) : "—", c?.last_seen_at ? fmt.dateTime(c.last_seen_at) : undefined)}
        </div>

        <div className="cgrid">
          <div className="col">
            <Panel title="Entitlements" link={<button type="button" className="linkbtn" onClick={() => setDialog({ kind: "grant" })}>Grant →</button>} flush>
              {d.summary.isError ? <Failed error={d.summary.error} retry={() => d.summary.refetch()} /> : !s ? <Loading lines={2} />
                : s.blocked ? <div className="pnote" role="status">This customer is blocked, so no purchase or grant gives access. <Link to={`/projects/${pid}/settings/blocked-customers`}>Blocked customers →</Link></div>
                : !s.active_entitlements.length && !grants.length ? <div className="pnote">No active entitlements. A purchase of an attached product unlocks one, or you can grant access.</div>
                : (
                  <>
                    {s.active_entitlements.map((e) => {
                      const grant = grants.find((g) => g.entitlement_id === e.entitlement_id);
                      return (
                        <div className="erow" key={e.entitlement_id}>
                          <div style={{ minWidth: 0 }}>
                            <b>{e.display_name}</b> <span className="mono subtle" style={{ fontSize: 12 }}>{e.lookup_key}</span>
                            <span className="dt">
                              {e.source === "promotional" ? "Granted" : <>From {productName(e.product_identifier ?? "")}</>}
                              {" · "}{e.expires_at ? <>{e.expires_at > Date.now() + 50 * 365 * DAY ? "never expires" : <>expires <span title={fmt.dateTime(e.expires_at)}>{fmt.date(e.expires_at)}</span> ({relative(e.expires_at)})</>}</> : "never expires"}
                              {grant && e.source !== "promotional" && <> · also granted until {fmt.date(grant.expires_at)}</>}
                            </span>
                          </div>
                          {grant ? <button type="button" className="btn btn-line" onClick={() => setDialog({ kind: "revoke", ent: grant })}>Revoke grant</button> : <Tag tone="up">Active</Tag>}
                        </div>
                      );
                    })}
                  </>
                )}
            </Panel>

            <Panel title="Subscriptions" flush>
              {d.subs.isError ? <Failed error={d.subs.error} retry={() => d.subs.refetch()} /> : d.subs.isLoading ? <Loading />
                : !subs.length ? <div className="pnote">No subscriptions.</div>
                : (
                  <div className="tbl"><table className="compact subs">
                    {/* Six columns with two-line cells (store under the product, renewal under the date), so the table fits its panel from 1024px up without scrolling sideways. */}
                    <thead><tr><th>Product</th><th>Status</th><th className="hide-sm">Started</th><th>Renews or ends</th><th className="amt">Price</th><th className="amt">Revenue</th></tr></thead>
                    <tbody>
                      {[...subs].sort((a, b) => b.current_period_starts_at - a.current_period_starts_at).map((x) => {
                        const ex = extra(x.id);
                        const st = SUB_STATUS[x.status] ?? { label: x.status, tone: "muted" as const };
                        const prod = productById(x.product_id);
                        const isPromo = x.store === "promotional";
                        const name = isPromo ? `Granted: ${x.entitlements.items.map((e) => e.display_name).join(", ") || "entitlement"}` : prod?.display_name ?? ex?.product_display_name ?? ex?.product_identifier ?? "Unknown product";
                        const kind = ex && ex.period_type !== "normal" && ex.period_type !== "trial" && !isPromo ? PERIOD_TYPE[ex.period_type] ?? ex.period_type : null;
                        return (
                          <tr key={x.id}>
                            <td className="subs-prod"><span title={ex ? `${ex.product_identifier} · ${x.store_subscription_identifier}` : x.store_subscription_identifier}>{name}</span> <Env env={x.environment} /><span className="l2">{storeLabel(x.store)}</span></td>
                            <td className="nw"><Tag tone={st.tone}>{st.label}</Tag>{kind && <span className="l2">{kind}</span>}</td>
                            <td className="nw subtle hide-sm" title={fmt.dateTime(x.starts_at)}>{shortDate(x.starts_at)}</td>
                            <td className="nw subtle" title={x.ends_at ? fmt.dateTime(x.ends_at) : undefined}>{x.ends_at ? shortDate(x.ends_at) : "—"}{x.gives_access && <span className="l2">{RENEWAL[x.auto_renewal_status] ?? x.auto_renewal_status}</span>}</td>
                            <td className="amt nw" title={ex?.duration ? `Every ${durationWords(ex.duration)}` : undefined}>{ex?.price ? <>{money(ex.price.amount, ex.price.currency)}{per(ex.duration) && <span className="subtle">/{per(ex.duration)}</span>}</> : "—"}</td>
                            <td className={`amt nw${x.total_revenue_in_usd.gross < 0 ? " down" : ""}`}>{money(x.total_revenue_in_usd.gross)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table></div>
                )}
            </Panel>

            <Panel title="Non-subscription purchases" flush>
              {d.purchases.isError ? <Failed error={d.purchases.error} retry={() => d.purchases.refetch()} /> : d.purchases.isLoading ? <Loading lines={2} />
                : !purchases.length ? <div className="pnote">No one-time purchases.</div>
                : (
                  <div className="tbl"><table className="compact">
                    <thead><tr><th>Product</th><th>Type</th><th>Store</th><th>Purchased</th><th>Status</th><th className="amt">Revenue</th></tr></thead>
                    <tbody>
                      {[...purchases].sort((a, b) => b.purchased_at - a.purchased_at).map((p) => {
                        const ex = s?.purchases.find((x) => x.id === p.id);
                        return (
                          <tr key={p.id}>
                            <td>{productById(p.product_id)?.display_name ?? ex?.product_display_name ?? p.product_id} <Env env={p.environment} /></td>
                            <td className="subtle">{ex?.is_consumable ? "Consumable" : "Non-consumable"}</td>
                            <td className="subtle">{storeLabel(p.store)}</td>
                            <td className="subtle" title={fmt.dateTime(p.purchased_at)}>{shortDate(p.purchased_at)}</td>
                            <td><Tag tone={p.status === "refunded" ? "down" : "up"}>{p.status === "refunded" ? "Refunded" : "Owned"}</Tag></td>
                            <td className="amt">{money(p.revenue_in_usd.gross)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table></div>
                )}
            </Panel>

            {/* Below 1400px the page stacks, and the history moves after the customer's details (app.css .c-hist). */}
            <div className="c-hist"><Timeline pid={pid} id={id} entName={entName} productName={productName} /></div>
          </div>

          <div className="col">
            <Panel title="Customer details" flush>
              {!c ? <Loading /> : (
                <dl className="kvs">
                  <dt>App user ID</dt><dd><Copy value={id} /></dd>
                  <dt>Original ID</dt><dd>{s ? <Copy value={s.original_app_user_id} /> : "—"}</dd>
                  <dt>Aliases</dt><dd>{s ? (s.aliases.filter((a) => a !== s.original_app_user_id).length ? <span className="aliases">{s.aliases.filter((a) => a !== s.original_app_user_id).map((a) => <Link key={a} className="mono ul" style={{ fontSize: 12 }} to={`/projects/${pid}/customers/${encodeURIComponent(a)}`}>{a}</Link>)}</span> : <span className="subtle">None</span>) : "—"}</dd>
                  <dt>First seen</dt><dd>{fmt.dateTime(c.first_seen_at)}</dd>
                  <dt>Last seen</dt><dd>{c.last_seen_at ? fmt.dateTime(c.last_seen_at) : "—"}</dd>
                  <dt>Platform</dt><dd>{platform ?? "—"}</dd>
                  <dt>App version</dt><dd className="mono" style={{ fontSize: 12 }}>{c.last_seen_app_version ?? "—"}</dd>
                  <dt>Country</dt><dd>{country ? <><span className="flag" aria-hidden>{flag(country)}</span>{country}</> : "—"}</dd>
                  <dt>Stores</dt><dd>{s?.stores.length ? s.stores.map(storeLabel).join(", ") : "—"}</dd>
                </dl>
              )}
            </Panel>

            <Panel title="Current offering" link={<button type="button" className="linkbtn" onClick={() => setDialog({ kind: "offering" })}>Change →</button>} flush>
              {!s ? <Loading lines={1} /> : s.offering_override ? (
                <div className="erow"><div><b>{s.offering_override.display_name}</b> <span className="mono subtle" style={{ fontSize: 12 }}>{s.offering_override.lookup_key}</span><span className="dt">Override for this customer only</span></div><Tag tone="gold">Override</Tag></div>
              ) : s.current_offering && s.current_offering.source !== "default" ? (
                <div className="erow"><div><b>{s.current_offering.display_name}</b> <span className="mono subtle" style={{ fontSize: 12 }}>{s.current_offering.lookup_key}</span>
                  <span className="dt">{s.current_offering.source === "experiment"
                    ? <>Variant {s.current_offering.variant?.toUpperCase()}{s.current_offering.variant_name ? ` (${s.current_offering.variant_name})` : ""} of the experiment <Link className="ul" to={`/projects/${pid}/experiments/${s.current_offering.experiment_id}`}>{s.current_offering.experiment_name ?? s.current_offering.experiment_id}</Link></>
                    : <>From the targeting rule <Link className="ul" to={`/projects/${pid}/targeting`}>{s.current_offering.rule_name ?? s.current_offering.rule_id}</Link></>}</span></div>
                  <Tag tone="gold">{s.current_offering.source === "experiment" ? "Experiment" : "Targeting"}</Tag></div>
              ) : (
                <div className="erow"><div><b>{currentOffering?.display_name ?? "No current offering"}</b>{currentOffering && <> <span className="mono subtle" style={{ fontSize: 12 }}>{currentOffering.lookup_key}</span></>}<span className="dt">The project's current offering</span></div><Tag>Default</Tag></div>
              )}
            </Panel>

            {c && <Currencies pid={pid} id={id} onDone={(m) => void refresh(m)} />}

            {c && <Attributes attrs={c.attributes?.items ?? []} onEdit={(a) => setDialog({ kind: "attr", attr: a })} onAdd={() => setDialog({ kind: "attr" })} />}

            <div className="c-del"><Panel title="Delete customer" flush>
              <div className="danger-zone"><span>Erase this customer and all their data.</span><button type="button" className="btn btn-danger" onClick={() => setDialog({ kind: "delete" })}><Icon name="trash" />Delete</button></div>
            </Panel></div>
          </div>
        </div>
      </div>

      {dialog?.kind === "grant" && <GrantDialog pid={pid} id={id} entitlements={ents} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === "offering" && <OfferingDialog pid={pid} id={id} offerings={offerings} current={s?.offering_override?.id ?? null} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === "attr" && <AttributeDialog pid={pid} id={id} initial={dialog.attr} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === "delete" && <DeleteDialog pid={pid} id={id} onClose={() => setDialog(null)} />}
      {dialog?.kind === "revoke" && (
        <ConfirmDialog title={`Revoke ${dialog.ent.display_name}?`} confirmLabel="Revoke grant" danger onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api(`/v2/projects/${pid}/customers/${encodeURIComponent(id)}/actions/revoke_granted_entitlement`, { method: "POST", json: { entitlement_id: dialog.ent.entitlement_id } });
            await refresh(`Revoked the granted ${dialog.ent.display_name}.`);
          }}>
          <p>The grant ends now. Access from a store purchase of the same entitlement stays.</p>
          <p className="subtle">Granted {fmt.date(dialog.ent.granted_at)}, would have ended {dialog.ent.expires_at ? fmt.date(dialog.ent.expires_at) : "never"}.</p>
        </ConfirmDialog>
      )}
    </Shell>
  );
}
