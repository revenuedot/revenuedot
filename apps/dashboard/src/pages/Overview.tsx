/*
 * Overview: the six live metric cards, recent transactions, setup health, and the first-run checklist.
 * Layout: prd/dashboard/mockup.html. Data: GET /v2/projects/{id}/metrics/overview (RevenueCat's shape), plus our
 * extensions /metrics/history, /transactions and /setup_health.
 *
 * GAPS versus RevenueCat's Overview (company/docs/research/contact-sheets/revenuecat/frames/01-overview.jpg):
 * - Project filter chips ("All projects" plus one chip per project): later tier; the project switcher sits in the sidebar.
 * - Info tooltips that define each card: the definitions are in the card's title attribute instead.
 * - Only the card's label links to its chart; RevenueCat opens the chart from anywhere on the card.
 * - Active customers has no sparkline: only each customer's latest visit is stored, so there is no daily history.
 * - Setup health has no SDK-version row and no migration row yet: the API does not record SDK versions or imports.
 * - Currency is USD only (the API refuses other currencies rather than mislabel them).
 */
import { useEffect, useMemo, useState } from "react";
import { AskBar, FirstSaleCard, GrowthInsights } from "./ai/OverviewBits";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shell } from "../components/Shell";
import { Icon } from "../components/icons";
import { Dialog, Field, Segmented, Sparkline, Switch, Tag, useProjectId, useToast } from "../components/ui";
import { api, ApiError, fmt, type List } from "../lib/api";
import { apiOrigin } from "./setup/data";
import { flag, money, relative, shortId, storeLabel, TX_TAG, type App, type Entitlement, type Offering, type Product, type Transaction } from "../lib/customers";

type MetricId = "active_trials" | "active_subscriptions" | "mrr" | "revenue" | "new_customers" | "active_users";
interface OverviewMetric { id: MetricId; name: string; description: string; unit: string; period: string; value: number }
interface History { id: MetricId; days: number; value: number; previous_value: number | null; values: { date: string; value: number }[] | null }
interface SetupHealth {
  apps: {
    id: string; name: string; type: string; notification_url: string | null; last_notification_at: number | null; credentials_configured: boolean;
    notification_status?: "ready" | "failing" | "received" | "waiting"; last_notification_error?: { at: number; message: string } | null;
  }[];
  webhooks: { total: number; attempted_24h: number; delivered_24h: number; failed_24h: number; pending: number; delivered_percent_24h: number | null;
    failing: { id: string; name: string; url: string; last_status: number | null; last_error: string | null; last_attempt_at: number; delivery_status: string }[] };
}

const PERIODS = [
  { value: "7d", label: "7D", days: 7, words: "7 days" },
  { value: "28d", label: "28D", days: 28, words: "28 days" },
  { value: "90d", label: "90D", days: 90, words: "90 days" },
  { value: "12m", label: "12M", days: 365, words: "12 months" },
] as const;
type Period = (typeof PERIODS)[number]["value"];

const CARDS: { id: MetricId; label: string; icon: string; stock: boolean; money?: boolean; define: string }[] = [
  { id: "active_trials", label: "Active trials", icon: "hourglass", stock: true, define: "Trials that currently give access, including cancelled trials that have not ended yet." },
  { id: "active_subscriptions", label: "Active subscriptions", icon: "box", stock: true, define: "Paid subscriptions that currently give access, including cancelled ones that have not ended and ones in a grace period. Trials and granted entitlements are not counted." },
  { id: "mrr", label: "MRR", icon: "refresh", stock: true, money: true, define: "Monthly recurring revenue: each active paid subscription's price in USD, normalised to one month." },
  { id: "revenue", label: "Revenue", icon: "dollar", stock: false, money: true, define: "Gross revenue from purchases and renewals in the period, minus refunds, in USD." },
  { id: "new_customers", label: "New customers", icon: "userplus", stock: false, define: "App user IDs first seen in the period. Aliases of one customer count once." },
  { id: "active_users", label: "Active customers", icon: "customers", stock: false, define: "Customers whose app contacted RevenueDot in the period. Aliases of one customer count once." },
];

/** The chart behind each card. */
const CHART_OF: Record<MetricId, string> = { active_trials: "trials", active_subscriptions: "actives", mrr: "mrr", revenue: "revenue", new_customers: "customers_new", active_users: "customers_active" };

/** Re-renders every `ms` so "last received 4s ago" stays true. Off when the user prefers reduced motion. */
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function MetricValue({ value, isMoney }: { value: number; isMoney?: boolean }) {
  if (!isMoney) return <>{fmt.int(value)}</>;
  const [whole, cents] = money(value).split(".");
  return <>{whole}{cents && cents !== "00" && <small>.{cents}</small>}</>;
}

function Delta({ value, previous, stock, words, isMoney }: { value: number; previous: number | null; stock: boolean; words: string; isMoney?: boolean }) {
  if (previous === null || previous === 0) return null;
  const pct = ((value - previous) / Math.abs(previous)) * 100;
  const s = `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(1)}%`;
  const prev = isMoney ? money(previous) : fmt.int(previous);
  return <span className={`d ${pct > 0 ? "up" : pct < 0 ? "down" : ""}`} title={stock ? `${prev} ${words} ago` : `${prev} in the ${words} before`}>{s}</span>;
}

function MetricGrid({ pid, env, period }: { pid: string; env: string; period: (typeof PERIODS)[number] }) {
  const overview = useQuery({ queryKey: ["overview", pid, env], queryFn: () => api<{ metrics: OverviewMetric[] }>(`/v2/projects/${pid}/metrics/overview?environment=${env}`), refetchInterval: 60_000 });
  const hist = useQueries({
    queries: CARDS.map((c) => ({
      queryKey: ["history", pid, env, c.id, period.days],
      queryFn: () => api<History>(`/v2/projects/${pid}/metrics/history?metric=${c.id}&days=${period.days}&environment=${env}`),
      refetchInterval: 60_000,
    })),
  });
  if (overview.isError) return <ErrorBanner error={overview.error} retry={() => overview.refetch()} what="the metrics" />;
  return (
    <section className="grid" aria-label="Key metrics" aria-busy={overview.isLoading}>
      {CARDS.map((c, i) => {
        const h = hist[i]!.data;
        const base = overview.data?.metrics.find((m) => m.id === c.id)?.value;
        // Card values follow RevenueCat's definitions; the period changes the window of the flow metrics.
        const value = c.stock || period.days === 28 ? base : h?.value;
        const context = c.id === "mrr" ? "monthly recurring revenue" : c.stock ? "in total" : `last ${period.words}`;
        return (
          <article className="m" key={c.id} title={c.define} data-metric={c.id}>
            <div className="lab"><Link to={`/projects/${pid}/charts/${CHART_OF[c.id]}`} className="ul" title={`Open the ${c.label} chart`}>{c.label}</Link><Icon name={c.icon} /></div>
            {value === undefined ? <span className="sk num" /> : <div className="v"><MetricValue value={value} isMoney={c.money} /></div>}
            <div className="meta">
              {value !== undefined && h && <Delta value={value} previous={h.previous_value} stock={c.stock} words={period.words} isMoney={c.money} />}
              <span>{context}</span>
            </div>
            {h?.values && h.values.length > 1 ? <Sparkline values={h.values.map((v) => v.value)} />
              : h ? <div className="nohist">No daily history: only each customer's latest visit is stored.</div>
              : <span className="sk" style={{ height: 44, marginTop: 10 }} />}
          </article>
        );
      })}
    </section>
  );
}

function ErrorBanner({ error, retry, what }: { error: unknown; retry: () => void; what: string }) {
  return (
    <div className="banner err" role="alert" style={{ alignItems: "center" }}>
      <span style={{ flex: 1 }}>Could not load {what}: {error instanceof Error ? error.message : "unknown error"}.</span>
      <button type="button" className="btn btn-line" onClick={retry}>Retry</button>
    </div>
  );
}

function RecentTransactions({ pid, env, products, entitlements }: { pid: string; env: string; products: Product[]; entitlements: Entitlement[] }) {
  const tx = useQuery({ queryKey: ["tx", pid, env], queryFn: () => api<List<Transaction>>(`/v2/projects/${pid}/transactions?limit=8&environment=${env}`), refetchInterval: 30_000 });
  const [more, setMore] = useState<Transaction[]>([]);
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => { setMore([]); setNext(null); }, [pid, env]);
  const name = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of products) { m.set(`${p.app_id}:${p.store_identifier}`, p.display_name ?? p.store_identifier); if (!m.has(p.store_identifier)) m.set(p.store_identifier, p.display_name ?? p.store_identifier); }
    return (t: Transaction) => m.get(`${t.app_id}:${t.product_identifier}`) ?? m.get(t.product_identifier) ?? t.product_identifier;
  }, [products]);
  const rows = [...(tx.data?.items ?? []), ...more];
  const cursor = more.length ? next : tx.data?.next_page ?? null;
  const loadMore = async () => {
    if (!cursor) return;
    const r = await api<List<Transaction>>(cursor);
    setMore((m) => [...m, ...r.items]); setNext(r.next_page);
  };
  return (
    <section className="panel" aria-label="Recent transactions">
      <div className="ph"><b>Recent transactions</b>{env === "sandbox" && <Tag tone="info">Sandbox</Tag>}</div>
      {tx.isError ? <div className="pb"><ErrorBanner error={tx.error} retry={() => tx.refetch()} what="transactions" /></div>
        : tx.isLoading ? <div className="pb" style={{ display: "grid", gap: 14 }}>{[0, 1, 2, 3].map((i) => <span key={i} className="sk line" style={{ width: `${90 - i * 12}%` }} />)}</div>
        : !rows.length ? <div className="pnote">{env === "sandbox" ? "No sandbox purchases yet. Make a test purchase with a Test Store key to see it here." : "No production purchases yet. They appear here seconds after a store confirms them."}</div>
        : (
          <>
            <div className="tbl"><table className="compact">
              <thead><tr><th>Customer</th><th>Type</th><th>Product</th><th>Store</th><th>When</th><th>Expires</th><th className="amt">Revenue</th></tr></thead>
              <tbody>
                {rows.map((t) => {
                  const promo = t.store === "promotional";
                  const tag = promo ? { label: "Granted", tone: "muted" as const } : TX_TAG[t.kind] ?? { label: t.kind, tone: "muted" as const };
                  return (
                    <tr key={t.id}>
                      <td className="id"><span className="idcell">{t.country && <span className="flag" role="img" aria-label={t.country}>{flag(t.country)}</span>}<Link to={`/projects/${pid}/customers/${encodeURIComponent(t.customer_id)}`} title={t.customer_id}>{shortId(t.customer_id)}</Link></span></td>
                      <td><Tag tone={tag.tone}>{tag.label}</Tag></td>
                      <td>{promo ? (() => { const k = t.product_identifier.replace(/^rc_promo_(.+)_\w+$/, "$1"); return entitlements.find((e) => e.lookup_key === k)?.display_name ?? k; })() : name(t)}</td>
                      <td className="subtle">{storeLabel(t.store)}</td>
                      <td className="subtle" title={fmt.dateTime(t.purchased_at)}>{relative(t.purchased_at)}</td>
                      <td className="subtle" title={t.expires_at ? fmt.dateTime(t.expires_at) : undefined}>{t.kind === "refund" ? "—" : t.expires_at ? relative(t.expires_at) : "Never"}</td>
                      <td className={`amt${t.revenue_in_usd < 0 ? " down" : ""}`}>{t.kind === "trial" || promo ? "—" : money(t.revenue_in_usd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
            {cursor && <div className="pfoot"><span>{rows.length} shown</span><button type="button" className="linkbtn" onClick={loadMore}>Show more ↓</button></div>}
          </>
        )}
    </section>
  );
}

function SetupHealthPanel({ pid }: { pid: string }) {
  const now = useNow(1000);
  const h = useQuery({ queryKey: ["setup_health", pid], queryFn: () => api<SetupHealth>(`/v2/projects/${pid}/setup_health`), refetchInterval: 30_000 });
  const appLink = (id: string) => `/projects/${pid}/apps/${id}`;
  const rows: { key: string; tone: "ok" | "bad" | "idle"; title: string; detail: React.ReactNode; right?: React.ReactNode }[] = [];
  if (h.data) {
    const types = h.data.apps.map((a) => a.type);
    if (!h.data.apps.length) rows.push({ key: "noapps", tone: "idle", title: "No apps connected", detail: "Connect the App Store, Google Play or the Test Store to start.", right: <Link className="r" to={`/projects/${pid}/apps`}>Add app →</Link> });
    for (const a of h.data.apps) {
      const many = types.filter((t) => t === a.type).length > 1;
      if (a.type === "test_store") { rows.push({ key: a.id, tone: "ok", title: many ? `Test Store · ${a.name}` : "Test Store", detail: "Ready for sandbox test purchases" }); continue; }
      if (a.notification_url) {
        const label = `${storeLabel(a.type)} notifications${many ? ` · ${a.name}` : ""}`;
        const at = a.last_notification_at;
        const recent = at !== null && now - at < 86400_000;
        const err = a.notification_status === "failing" ? a.last_notification_error : null;
        rows.push(err ? {
          key: `${a.id}-n`, tone: "bad", title: label, detail: `The last notification failed ${fmt.ago(err.at)}: ${err.message}`, right: <Link className="r" to={appLink(a.id)}>Fix →</Link>,
        } : {
          key: `${a.id}-n`, tone: at === null ? "idle" : recent ? "ok" : "bad", title: label,
          detail: at === null ? `None received yet. Add the notification URL in ${a.type === "play_store" ? "Google Play Console" : "App Store Connect"}.`
            : <>{recent && <i className="live" aria-hidden />}Last received {fmt.ago(at).replace(" ago", "")} ago</>,
          right: at === null ? <Link className="r" to={appLink(a.id)}>Set up →</Link> : undefined,
        });
      }
      if (!a.credentials_configured) {
        const what = a.type === "app_store" ? "In-app purchase key missing" : a.type === "play_store" ? "Service account credentials missing" : "Store credentials missing";
        rows.push({ key: `${a.id}-c`, tone: "bad", title: `${a.name}: ${what}`, detail: "Purchases from this app cannot be verified until you add them.", right: <Link className="r" to={appLink(a.id)}>Fix →</Link> });
      }
    }
    const w = h.data.webhooks;
    if (!w.total) rows.push({ key: "wh", tone: "idle", title: "Webhooks", detail: "No endpoints yet. Send purchase events to your backend.", right: <Link className="r" to={`/projects/${pid}/integrations/webhooks/new`}>Add →</Link> });
    for (const f of w.failing) {
      let host = f.url; try { host = new URL(f.url).host; } catch { /* keep the url */ }
      const at = new Date(f.last_attempt_at);
      const since = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")} UTC`;
      rows.push({ key: `wh-${f.id}`, tone: "bad", title: `Webhook: ${host}`, detail: `${f.last_status ?? f.last_error ?? "Error"} at ${since} · ${f.delivery_status === "pending" ? "retrying" : "gave up"}`, right: <Link className="r" to={`/projects/${pid}/integrations/webhooks/${f.id}`}>{w.pending} queued</Link> });
    }
    if (w.total && !w.failing.length) rows.push({ key: "wh-ok", tone: "ok", title: `Webhooks · ${w.total} endpoint${w.total === 1 ? "" : "s"}`, detail: w.attempted_24h ? `${w.delivered_percent_24h}% delivered in the last 24 hours` : "No events to deliver in the last 24 hours", right: w.attempted_24h ? <span className="r">{w.delivered_24h}/{w.attempted_24h}</span> : undefined });
  }
  return (
    <section className="panel health" aria-label="Setup health">
      <div className="ph"><b>Setup health</b><Link className="link" to={`/projects/${pid}/apps`}>Apps →</Link></div>
      {h.isError ? <div className="pb"><ErrorBanner error={h.error} retry={() => h.refetch()} what="setup health" /></div>
        : h.isLoading ? <div className="pb" style={{ display: "grid", gap: 14 }}>{[0, 1, 2].map((i) => <span key={i} className="sk line" />)}</div>
        : rows.map((r) => (
          <div className="hrow" key={r.key} data-tone={r.tone}>
            <i className={`dot ${r.tone}`} aria-label={r.tone === "ok" ? "Healthy" : r.tone === "bad" ? "Needs attention" : "Not set up"} role="img" />
            <div><b>{r.title}</b><span className="dt">{r.detail}</span></div>
            {r.right ?? <span />}
          </div>
        ))}
    </section>
  );
}

/* ---------- First-run checklist ---------- */

interface SetupState { apps: App[]; products: Product[]; entitlements: (Entitlement & { products?: { items: unknown[] } })[]; offerings: Offering[]; hasCustomer: boolean; hasPurchase: boolean }

type Lang = "swift" | "kotlin" | "rn" | "flutter";
type Mode = "fresh" | "moving";
const LANGS: { value: Lang; label: string }[] = [{ value: "swift", label: "Swift" }, { value: "kotlin", label: "Kotlin" }, { value: "rn", label: "React Native" }, { value: "flutter", label: "Flutter" }];

/**
 * Setup code per platform. `install` adds the open-source RevenueCat SDK (MIT), which RevenueDot answers; `configure`
 * points it at this server. Apps that already ship the RevenueCat SDK only need `configure`'s first line and the new key.
 */
const SETUP: Record<Lang, { install: string; installHint: string; configure: (u: string, k: string) => string; use: string }> = {
  swift: {
    install: "https://github.com/RevenueCat/purchases-ios-spm.git", installHint: "Xcode: File > Add Package Dependencies, paste this URL, add the RevenueCat library.",
    configure: (u, k) => `import RevenueCat\n\n// In your App's init or application(_:didFinishLaunchingWithOptions:)\nPurchases.proxyURL = URL(string: "${u}")!\nPurchases.configure(withAPIKey: "${k}")`,
    use: `let offerings = try await Purchases.shared.offerings()\nlet result = try await Purchases.shared.purchase(package: offerings.current!.availablePackages[0])\nlet isPro = result.customerInfo.entitlements["pro"]?.isActive == true`,
  },
  kotlin: {
    install: `implementation("com.revenuecat.purchases:purchases:10.24.0")`, installHint: "Add it to your app module's build.gradle.kts dependencies.",
    configure: (u, k) => `// In Application.onCreate()\nPurchases.proxyURL = URL("${u}")\nPurchases.configure(PurchasesConfiguration.Builder(this, "${k}").build())`,
    use: `val offerings = Purchases.sharedInstance.awaitOfferings()\nval result = Purchases.sharedInstance.awaitPurchase(PurchaseParams.Builder(activity, offerings.current!!.availablePackages[0]).build())\nval isPro = result.customerInfo.entitlements["pro"]?.isActive == true`,
  },
  rn: {
    install: "npm install react-native-purchases", installHint: "Then run pod install in ios/.",
    configure: (u, k) => `import Purchases from "react-native-purchases";\n\nawait Purchases.setProxyURL("${u}");\nPurchases.configure({ apiKey: "${k}" });`,
    use: `const offerings = await Purchases.getOfferings();\nconst { customerInfo } = await Purchases.purchasePackage(offerings.current.availablePackages[0]);\nconst isPro = customerInfo.entitlements.active["pro"] !== undefined;`,
  },
  flutter: {
    install: "flutter pub add purchases_flutter", installHint: "Run it in your Flutter project.",
    configure: (u, k) => `import 'package:purchases_flutter/purchases_flutter.dart';\n\nawait Purchases.setProxyURL("${u}");\nawait Purchases.configure(PurchasesConfiguration("${k}"));`,
    use: `final offerings = await Purchases.getOfferings();\nfinal info = await Purchases.purchasePackage(offerings.current!.availablePackages.first);\nfinal isPro = info.entitlements.active.containsKey("pro");`,
  },
};

function CodeCard({ label, code, hint }: { label: string; code: string; hint: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code" style={{ marginTop: 10 }}>
      <pre aria-label={label}>{code}</pre>
      <div className="cb">
        <span>{hint}</span>
        <button type="button" className="btn btn-ghost" aria-label={`Copy ${label}`} onClick={async () => { try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* clipboard blocked */ } }}>
          <Icon name={copied ? "check" : "copy"} />{copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function SdkSnippet({ pid, apps, mode, setMode }: { pid: string; apps: App[]; mode: Mode; setMode: (m: Mode) => void }) {
  const [lang, setLang] = useState<Lang>("swift");
  const app = apps.find((a) => a.type === (lang === "kotlin" ? "play_store" : "app_store")) ?? apps.find((a) => a.type !== "test_store") ?? apps[0];
  const key = useQuery({ queryKey: ["pubkey", pid, app?.id], enabled: !!app, queryFn: () => api<List<{ key: string }>>(`/v2/projects/${pid}/apps/${app!.id}/public_api_keys`) });
  const k = key.data?.items[0]?.key ?? "your_public_api_key";
  const url = apiOrigin();
  const s = SETUP[lang];
  const keyHint = app ? <>Key of <b style={{ color: "var(--fg-2)" }}>{app.name}</b>. Set the proxy URL before configure.</> : "Add an app to get its public API key. Set the proxy URL before configure.";
  const label = LANGS.find((x) => x.value === lang)!.label;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Segmented label="Your app" value={mode} options={[{ value: "fresh", label: "New to in-app purchases" }, { value: "moving", label: "Already on RevenueCat" }]} onChange={setMode} />
        <Segmented label="SDK" value={lang} options={LANGS} onChange={setLang} />
      </div>
      {mode === "fresh" ? (
        <>
          <p className="muted" style={{ margin: "12px 0 0", fontSize: 13 }}><b>1. Add the SDK.</b> RevenueDot works with the open-source RevenueCat SDK (MIT), so you install that package.</p>
          <CodeCard label={`${label} install`} code={s.install} hint={s.installHint} />
          <p className="muted" style={{ margin: "14px 0 0", fontSize: 13 }}><b>2. Configure it at launch</b>, pointed at RevenueDot.</p>
          <CodeCard label={`${label} setup code`} code={s.configure(url, k)} hint={keyHint} />
          <p className="muted" style={{ margin: "14px 0 0", fontSize: 13 }}><b>3. Show the offering, buy, and check access.</b></p>
          <CodeCard label={`${label} purchase code`} code={s.use} hint={<>Full guide: <a className="ul" href={`https://revenuedot.app/docs/sdks/${lang === "kotlin" ? "android" : lang === "swift" ? "ios" : lang === "rn" ? "react-native" : "flutter"}`} target="_blank" rel="noreferrer">{label} SDK</a></>} />
        </>
      ) : (
        <>
          <p className="muted" style={{ margin: "12px 0 0", fontSize: 13 }}>Keep your code. Add one line before configure and use this project's key instead of the RevenueCat one (or keep your old key with the importer).</p>
          <CodeCard label={`${label} setup code`} code={s.configure(url, k).split("\n").filter((l) => /proxy|ProxyURL|configure/i.test(l)).join("\n")} hint={keyHint} />
          <p className="muted" style={{ margin: "10px 0 0", fontSize: 13 }}>Moving customers and subscriptions too? <a className="ul" href="https://revenuedot.app/docs/migrate" target="_blank" rel="noreferrer">Migrate from RevenueCat</a>.</p>
        </>
      )}
    </div>
  );
}

function TestPurchaseDialog({ pid, apps, products, onClose, onDone }: { pid: string; apps: App[]; products: Product[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const testApp = apps.find((a) => a.type === "test_store");
  const own = products.filter((p) => p.app_id === testApp?.id);
  const [user, setUser] = useState("test_user_1");
  const [product, setProduct] = useState(own[0]?.id ?? "");
  const [price, setPrice] = useState("9.99");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!product && own[0]) setProduct(own[0].id); }, [own, product]);
  const createApp = async () => {
    setBusy(true); setError(null);
    try { await api(`/v2/projects/${pid}/apps`, { method: "POST", json: { name: "Test Store", type: "test_store" } }); await qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === pid }); toast("Test Store app created."); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Could not create the app."); } finally { setBusy(false); }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const n = Number(price);
    try {
      await api(`/v2/projects/${pid}/test_purchases`, { method: "POST", json: { app_user_id: user.trim(), product_id: product, ...(price.trim() && Number.isFinite(n) ? { price: n, currency: "USD" } : {}) } });
      toast(`Test purchase recorded for ${user.trim()}.`);
      onDone();
    } catch (err) { setError(err instanceof ApiError ? err.message : "The test purchase failed."); setBusy(false); }
  };
  if (!testApp) {
    return (
      <Dialog title="Make a test purchase" onClose={onClose} footer={<><button type="button" className="btn btn-line" onClick={onClose}>Cancel</button><button type="button" className="btn btn-dark" onClick={createApp} disabled={busy}>{busy ? "Creating…" : "Create Test Store app"}</button></>}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Test purchases run through the Test Store: no App Store or Google Play account needed, and every purchase is sandbox data. This project has no Test Store app yet.</p>
        {error && <div className="banner err" role="alert">{error}</div>}
      </Dialog>
    );
  }
  return (
    <Dialog title="Make a test purchase" onClose={onClose} footer={<><button type="button" className="btn btn-line" onClick={onClose}>Cancel</button><button type="submit" form="tp-form" className="btn btn-dark" disabled={busy || !own.length || !user.trim()}>{busy ? "Purchasing…" : "Purchase"}</button></>}>
      <form id="tp-form" onSubmit={submit} style={{ display: "contents" }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Runs a Test Store purchase through the same pipeline as a real one: the customer gets the entitlement, events and webhooks fire, and it shows up as sandbox data.</p>
        {!own.length ? <div className="banner warn">The Test Store app has no products. <Link className="ul" to={`/projects/${pid}/product-catalog/products`}>Create a product</Link> for it first.</div> : <>
          <Field label="App user ID" htmlFor="tp-user"><input id="tp-user" className="input mono" value={user} onChange={(e) => setUser(e.target.value)} required maxLength={100} /></Field>
          <Field label="Product" htmlFor="tp-product"><select id="tp-product" className="select" value={product} onChange={(e) => setProduct(e.target.value)}>{own.map((p) => <option key={p.id} value={p.id}>{p.display_name ?? p.store_identifier} ({p.store_identifier})</option>)}</select></Field>
          <Field label="Price in USD" htmlFor="tp-price" hint="Leave empty for a free purchase."><input id="tp-price" className="input mono" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
        </>}
        {error && <div className="banner err" role="alert">{error}</div>}
      </form>
    </Dialog>
  );
}

function SetupChecklist({ pid, s, onHide, firstRun }: { pid: string; s: SetupState; onHide?: () => void; firstRun: boolean }) {
  const [buying, setBuying] = useState(false);
  const [mode, setMode] = useState<Mode>("fresh");
  const qc = useQueryClient();
  const nav = useNavigate();
  const base = `/projects/${pid}`;
  const stores = s.apps.filter((a) => a.type !== "test_store");
  const steps = [
    { key: "store", title: "Connect a store", done: s.apps.length > 0,
      text: stores.length ? `${stores.map((a) => a.name).join(", ")} connected.` : s.apps.length ? "The Test Store is ready. Add your App Store or Google Play app when you are ready to sell." : "Add your App Store or Google Play app with its in-app purchase credentials, or start with the Test Store.",
      action: <Link className="btn btn-line" to={`${base}/apps`}>{s.apps.length ? "Manage apps" : "Add an app"}</Link> },
    { key: "products", title: "Create products", done: s.products.length > 0,
      text: s.products.length ? `${s.products.length} product${s.products.length === 1 ? "" : "s"} in the catalog.` : "Add each subscription and one-time purchase with the identifier it has in the store.",
      action: <Link className="btn btn-line" to={`${base}/product-catalog/products`}>{s.products.length ? "View products" : "Add products"}</Link> },
    { key: "entitlement", title: "Create an entitlement and attach products", done: s.entitlements.some((e) => (e.products?.items.length ?? 0) > 0),
      text: "An entitlement is the access your app checks, such as \"pro\". Attach the products that unlock it.",
      action: <Link className="btn btn-line" to={`${base}/product-catalog/entitlements`}>{s.entitlements.length ? "View entitlements" : "Add an entitlement"}</Link> },
    { key: "offering", title: "Create an offering", done: s.offerings.some((o) => o.is_current),
      text: "An offering is the set of packages your paywall shows. Mark one as current and change it later without an app release.",
      action: <Link className="btn btn-line" to={`${base}/product-catalog/offerings`}>{s.offerings.length ? "View offerings" : "Add an offering"}</Link> },
    { key: "sdk", title: mode === "fresh" ? "Add the SDK to your app" : "Point your SDK at RevenueDot", done: s.hasCustomer,
      text: mode === "fresh"
        ? "Install the SDK, configure it with this project's key, and show your offering. Customers appear here after the app's first call."
        : "Keep the RevenueCat SDK you already ship and change one line. Customers appear here after the app's first call.",
      body: <SdkSnippet pid={pid} apps={s.apps} mode={mode} setMode={setMode} /> },
    { key: "purchase", title: "Send a test purchase", done: s.hasPurchase,
      text: "Buy a product through the Test Store to see a customer, an entitlement and the events a real purchase creates.",
      action: <button type="button" className="btn btn-dark" onClick={() => setBuying(true)}>Make a test purchase</button> },
  ];
  const done = steps.filter((x) => x.done).length;
  const next = steps.findIndex((x) => !x.done);
  return (
    <section className="setup" aria-label="Set up your project">
      <div className="setup-h">
        <div>
          <h2>{firstRun ? "Set up your project" : "Finish setting up"}</h2>
          <p>{firstRun ? "Six steps from an empty project to your first purchase. Most apps finish in under an hour." : "A few steps are left before this project is ready for real customers."}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="meter" aria-label={`${done} of ${steps.length} steps done`}><i>{steps.map((x) => <b key={x.key} className={x.done ? "on" : ""} />)}</i>{done}/{steps.length}</span>
          {onHide && <button type="button" className="btn btn-ghost" onClick={onHide}>Hide</button>}
        </div>
      </div>
      <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {steps.map((x, i) => (
          <li key={x.key} className={`step${x.done ? " done" : ""}${i === next ? " next" : ""}`} aria-current={i === next ? "step" : undefined}>
            <span className="n" aria-hidden>{x.done ? <Icon name="check" /> : i + 1}</span>
            <div style={{ minWidth: 0 }}>
              <h3>{x.title}<span className="sr">{x.done ? " (done)" : ""}</span></h3>
              <p>{x.text}</p>
              {"body" in x && x.body}
            </div>
            {"action" in x && x.action ? <div className="go">{x.action}</div> : <span />}
          </li>
        ))}
      </ol>
      {buying && <TestPurchaseDialog pid={pid} apps={s.apps} products={s.products} onClose={() => setBuying(false)}
        onDone={async () => { setBuying(false); await qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === pid }); nav(`${base}/overview?environment=sandbox`); }} />}
    </section>
  );
}

/* ---------- Page ---------- */

export function Overview() {
  const pid = useProjectId();
  const [sp, setSp] = useSearchParams();
  const env = sp.get("environment") === "sandbox" ? "sandbox" : "production";
  const period = PERIODS.find((p) => p.value === sp.get("period")) ?? PERIODS[1];
  const hideKey = `rd-setup-hidden:${pid}`;
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(hideKey) === "1"; } catch { return false; } });
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v === null) n.delete(k); else n.set(k, v); setSp(n, { replace: true }); };

  const setup = useQuery({
    queryKey: ["setup", pid],
    queryFn: async (): Promise<SetupState> => {
      const P = `/v2/projects/${pid}`;
      const [apps, products, entitlements, offerings, customers, tx] = await Promise.all([
        api<List<App>>(`${P}/apps?limit=100`), api<List<Product>>(`${P}/products?limit=100`), api<List<SetupState["entitlements"][number]>>(`${P}/entitlements?limit=100&expand=items.product`),
        api<List<Offering>>(`${P}/offerings?limit=100`), api<List<unknown>>(`${P}/customers?limit=1`), api<List<unknown>>(`${P}/transactions?limit=1`),
      ]);
      return { apps: apps.items, products: products.items, entitlements: entitlements.items, offerings: offerings.items, hasCustomer: customers.items.length > 0, hasPurchase: tx.items.length > 0 };
    },
  });
  const prodTx = useQuery({ queryKey: ["tx-any", pid, "production"], queryFn: () => api<List<Transaction>>(`/v2/projects/${pid}/transactions?limit=25&environment=production`), enabled: env === "production" && !!setup.data?.hasPurchase });

  const s = setup.data;
  const allDone = s ? s.apps.length > 0 && s.products.length > 0 && s.entitlements.some((e) => (e.products?.items.length ?? 0) > 0) && s.offerings.some((o) => o.is_current) && s.hasCustomer && s.hasPurchase : true;
  const firstRun = !!s && !s.hasPurchase && !s.hasCustomer;
  // Granted entitlements are production records but not purchases.
  const onlySandbox = env === "production" && prodTx.data && !prodTx.data.items.some((t) => t.store !== "promotional");

  return (
    <Shell title="Overview">
      <div className="page">
        <div className="head">
          <div>
            <h1>Overview</h1>
            <p>All apps · USD · {firstRun ? "no purchases yet" : period.days === 28 ? "last 28 days compared with the 28 days before" : `last ${period.words} compared with the ${period.words} before`}</p>
          </div>
          {!firstRun && (
            <div className="actions">
              <Segmented label="Period" value={period.value as Period} options={PERIODS.map((p) => ({ value: p.value, label: p.label }))} onChange={(v) => set("period", v === "28d" ? null : v)} />
              <Switch label="Sandbox data" checked={env === "sandbox"} onChange={(v) => set("environment", v ? "sandbox" : null)} />
            </div>
          )}
        </div>

        {setup.isError && <ErrorBanner error={setup.error} retry={() => setup.refetch()} what="the project" />}

        {s && !allDone && (!hidden || firstRun) && (
          <SetupChecklist pid={pid} s={s} firstRun={firstRun} onHide={firstRun ? undefined : () => { setHidden(true); try { localStorage.setItem(hideKey, "1"); } catch { /* ignore */ } }} />
        )}

        {!firstRun && (
          <>
            <FirstSaleCard pid={pid} />
            <AskBar pid={pid} />
            {onlySandbox && (
              <div className="banner" role="status" style={{ alignItems: "center" }}>
                <span style={{ flex: 1 }}>No production purchases yet. Your test purchases are sandbox data.</span>
                <button type="button" className="btn btn-line" onClick={() => set("environment", "sandbox")}>Show sandbox data</button>
              </div>
            )}
            <MetricGrid pid={pid} env={env} period={period} />
            <GrowthInsights pid={pid} />
          </>
        )}

        <div className={firstRun ? undefined : "two"}>
          {!firstRun && <RecentTransactions pid={pid} env={env} products={s?.products ?? []} entitlements={s?.entitlements ?? []} />}
          <SetupHealthPanel pid={pid} />
        </div>
        {s && !allDone && hidden && !firstRun && (
          <p className="fn"><button type="button" className="linkbtn" onClick={() => { setHidden(false); try { localStorage.removeItem(hideKey); } catch { /* ignore */ } }}>Show the setup checklist</button></p>
        )}
      </div>
    </Shell>
  );
}
