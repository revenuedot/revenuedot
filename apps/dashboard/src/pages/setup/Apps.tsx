import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { CopyButton, Dialog, Disclosure, Field, PageHead, SecretText, StatusLine, Tag, useProjectId, useToast } from "../../components/ui";
import { api, fmt } from "../../lib/api";
import { STORES, base, errMsg, storeId, useApps, usePublicKey, useSetupHealth, type App, type AppType, type SdkVersion, type SetupHealth } from "./data";

/**
 * Apps (/projects/:projectId/apps): every store app in the project, its ids and public SDK key, setup state (including
 * failing store notifications), "Add app", and the SDK compatibility panel (which SDK builds call us, from
 * setup_health.sdk_versions).
 * GAPS vs RevenueCat (frame 22):
 * - RevenueCat's panel scores "feature coverage" (40/46); ours says whether the SDK's major version is covered by the
 *   contract tests and lists what differs in proxy mode.
 * - Mac App Store and Web Billing apps: the API creates them; Add app offers App Store, Google Play, Amazon Appstore,
 *   Stripe, Paddle, Roku, Samsung Galaxy Store and Test Store.
 */

export function StoreCell({ app }: { app: Pick<App, "name" | "type"> }) {
  const s = STORES[app.type] ?? { label: app.type, icon: "apps" };
  return <span className="appcell"><span className="tile"><Icon name={s.icon} /></span><span><b>{app.name}</b><small>{s.label}</small></span></span>;
}

export function KeyCell({ pid, appId }: { pid: string; appId: string }) {
  const k = usePublicKey(pid, appId);
  if (k.isLoading) return <span className="subtle">Loading…</span>;
  if (!k.data) return <span className="subtle">—</span>;
  return <SecretText value={k.data.key} label="public SDK key" />;
}

/** The one next step each app needs, from setup_health. */
export function setupState(app: App, h: SetupHealth["apps"][number] | undefined): { tone: "ok" | "bad" | "idle"; text: string; detail?: string } {
  if (app.type === "test_store") return { tone: "ok", text: "Ready" };
  if (!h) return { tone: "idle", text: "Checking…" };
  // An active failure first: every notification that fails is a purchase update this server missed.
  if (h.notification_status === "failing") return { tone: "bad", text: "Notifications failing", detail: h.last_notification_error?.message };
  if (!h.credentials_configured) {
    const need: Partial<Record<string, string>> = { play_store: "Add service account", amazon: "Add shared key", stripe: "Add Stripe API key", paddle: "Add Paddle API key", roku: "Add Roku Pay API key", galaxy: "Add service account" };
    return { tone: "bad", text: need[app.type] ?? "Add in-app purchase key" };
  }
  if (h.notification_url && !h.last_notification_at) return { tone: "idle", text: "Waiting for store notifications" };
  return { tone: "ok", text: "Ready" };
}

/** The package developers install, from the SDK's X-Platform and X-Platform-Flavor headers. */
function sdkPackage(v: Pick<SdkVersion, "platform" | "platform_flavor">): string {
  const flavor = v.platform_flavor.toLowerCase();
  const byFlavor: Record<string, string> = {
    "react-native": "react-native-purchases", flutter: "purchases_flutter", capacitor: "purchases-capacitor", unity: "purchases-unity",
    cordova: "cordova-plugin-purchases", kmp: "purchases-kmp", "purchases-js": "purchases-js",
  };
  if (byFlavor[flavor]) return byFlavor[flavor]!;
  if (/^(android|amazon)$/i.test(v.platform)) return "purchases-android";
  if (/^(ios|watchos|tvos|macos|uikitformac|visionos)$/i.test(v.platform)) return "purchases-ios";
  return flavor === "native" ? v.platform : v.platform_flavor;
}

/** What developers call the version: the hybrid SDK's own version when there is one. */
const shownVersion = (v: SdkVersion) => (v.platform_flavor !== "native" && v.platform_flavor_version) || v.sdk_version;

const semver = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0), pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

interface SdkGroup { key: string; platform: string; pkg: string; latest: SdkVersion; popular: SdkVersion; popularShare: number | null; builds: SdkVersion[]; untested: string[]; caveats: string[] }

export function sdkGroups(list: SdkVersion[]): SdkGroup[] {
  const groups = new Map<string, SdkVersion[]>();
  for (const v of list) {
    const key = `${v.platform.toLowerCase()}|${sdkPackage(v)}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  return [...groups.entries()].map(([key, builds]) => {
    // One entry per version: the same build can call several apps.
    const byVersion = new Map<string, SdkVersion & { n: number }>();
    for (const b of builds) {
      const cur = byVersion.get(shownVersion(b));
      byVersion.set(shownVersion(b), cur ? { ...cur, n: Math.max(cur.n, b.customers_30d), last_seen_at: Math.max(cur.last_seen_at, b.last_seen_at) } : { ...b, n: b.customers_30d });
    }
    const versions = [...byVersion.values()];
    const latest = versions.reduce((a, b) => (semver(shownVersion(b), shownVersion(a)) > 0 ? b : a));
    const total = versions.reduce((a, b) => a + b.n, 0);
    const popular = total ? versions.reduce((a, b) => (b.n > a.n ? b : a)) : versions.reduce((a, b) => (b.last_seen_at > a.last_seen_at ? b : a));
    return {
      key, platform: builds[0]!.platform, pkg: sdkPackage(builds[0]!), latest, popular, popularShare: total ? popular.n / total : null,
      builds: [...builds].sort((a, b) => b.last_seen_at - a.last_seen_at),
      untested: [...new Set(versions.filter((v) => v.support !== "verified").map(shownVersion))],
      caveats: [...new Set(builds.flatMap((b) => b.caveats))],
    };
  }).sort((a, b) => a.platform.localeCompare(b.platform) || a.pkg.localeCompare(b.pkg));
}

const PLATFORMS: Record<string, string> = { ios: "iOS", android: "Android", amazon: "Amazon", macos: "macOS", tvos: "tvOS", watchos: "watchOS", visionos: "visionOS", uikitformac: "Mac Catalyst", web: "Web" };
const platformLabel = (p: string) => PLATFORMS[p.toLowerCase()] ?? p;

const pct = (x: number) => `${(x * 100).toFixed(x === 1 ? 0 : 1)}%`;

/** RevenueCat's "SDK Compatibility" panel (frame 22): which SDKs call this project and how well each works here. */
export function SdkCompatibility({ list, apps }: { list: SdkVersion[] | undefined; apps: App[] }) {
  const groups = sdkGroups(list ?? []);
  const caveats = [...new Set(groups.flatMap((g) => g.caveats))];
  const appName = (id: string | null) => apps.find((a) => a.id === id)?.name ?? "—";
  return (
    <section className="panel" aria-labelledby="sdk-compat-h">
      <div className="ph"><b id="sdk-compat-h">SDK compatibility</b><span className="link">Last 30 days</span></div>
      {!groups.length ? (
        <div className="pb"><p className="section-sub">No SDK has called this project yet. Run your app with the proxy URL set and its SDK and version show up here within a minute.</p></div>
      ) : (
        <>
          <div className="tbl">
            <table>
              <thead><tr><th>Platform</th><th>SDK</th><th>Latest version</th><th>Most used version</th><th>Support</th></tr></thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key}>
                    <td>{platformLabel(g.platform)}</td>
                    <td className="id">{g.pkg}</td>
                    <td className="id">{shownVersion(g.latest)}</td>
                    <td className="id">{shownVersion(g.popular)}{g.popularShare !== null && <span className="subtle"> ({pct(g.popularShare)})</span>}</td>
                    <td>{g.untested.length
                      ? <span title={`Versions our contract tests do not cover yet: ${g.untested.join(", ")}. They use the same protocol and are expected to work.`}><Tag tone="info">Untested version</Tag></span>
                      : <Tag tone="up">Supported</Tag>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!!caveats.length && (
            <Disclosure title="What differs with the stock SDK (proxy mode)" sub={`${caveats.length} ${caveats.length === 1 ? "note" : "notes"}. The RevenueDot SDK forks remove all of them.`}>
              <ul className="notes">{caveats.map((c) => <li key={c}>{c}</li>)}</ul>
            </Disclosure>
          )}
          <Disclosure title="Every SDK build" sub={`${groups.reduce((a, g) => a + g.builds.length, 0)} builds, newest first`}>
            <div className="tbl">
              <table>
                <thead><tr><th>SDK</th><th>Version</th><th>App</th><th>OS version</th><th className="amt">Customers</th><th>Last seen</th></tr></thead>
                <tbody>
                  {groups.flatMap((g) => g.builds.map((b) => (
                    <tr key={`${b.app_id}|${b.platform}|${b.platform_flavor}|${b.platform_flavor_version}|${b.sdk_version}`}>
                      <td className="id">{g.pkg}</td>
                      <td className="id">{shownVersion(b)}{shownVersion(b) !== b.sdk_version && <span className="subtle"> (native {b.sdk_version})</span>}</td>
                      <td>{appName(b.app_id)}</td>
                      <td className="subtle">{b.platform_version ?? "—"}</td>
                      <td className="amt">{b.customers_30d}</td>
                      <td className="subtle">{fmt.ago(b.last_seen_at)}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          </Disclosure>
        </>
      )}
    </section>
  );
}

const CHOICES: { type: AppType; label: string; text: string; soon?: boolean }[] = [
  { type: "app_store", label: "App Store", text: "iPhone, iPad, Mac, Apple TV and Vision Pro apps." },
  { type: "play_store", label: "Google Play", text: "Android apps sold through Google Play." },
  { type: "test_store", label: "Test Store", text: "Try purchases without any store. Nothing is charged." },
  { type: "amazon", label: "Amazon Appstore", text: "Fire tablets and Fire TV." },
  { type: "galaxy", label: "Galaxy Store", text: "Android apps sold in the Samsung Galaxy Store." },
  { type: "roku", label: "Roku", text: "Roku channels with Roku Pay." },
  { type: "stripe", label: "Stripe", text: "Subscriptions sold with your own Stripe account." },
  { type: "paddle", label: "Paddle", text: "Web sales through Paddle Billing, tax handled." },
];

const BUNDLE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const PACKAGE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

/** Stores Add app offers (the others show as "Soon"). */
const ADDABLE: AppType[] = CHOICES.filter((c) => !c.soon).map((c) => c.type);

export function AddAppDialog({ pid, onClose, initial }: { pid: string; onClose: () => void; initial?: AppType }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<AppType>(initial ?? "app_store");
  const [name, setName] = useState(initial === "test_store" ? "Test Store" : "");
  const [id, setId] = useState("");
  const [errors, setErrors] = useState<{ name?: string; id?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const s = STORES[type]!;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim(), i = id.trim();
    const errs: typeof errors = {};
    if (!n) errs.name = "Give the app a name, for example Scanner iOS.";
    if (s.idField === "bundle_id" && !BUNDLE.test(i)) errs.id = i ? "A bundle ID looks like com.company.app." : "Enter the bundle ID from Xcode.";
    if (s.idField === "package_name" && !PACKAGE.test(i)) errs.id = i ? "A package name looks like com.company.app (letters, digits and underscores)." : type === "amazon" ? "Enter the package name from the Amazon Appstore Console." : type === "galaxy" ? "Enter the package name from Samsung Seller Portal." : "Enter the package name from Play Console.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const app = await api<App>(`${base(pid)}/apps`, { method: "POST", json: { name: n, type, ...(s.idField ? { [type]: { [s.idField]: i } } : {}) } });
      await qc.invalidateQueries({ queryKey: ["apps", pid] });
      await qc.invalidateQueries({ queryKey: ["setup_health", pid] });
      toast(`${n} added. Next: connect it to ${s.label === "Test Store" ? "your app" : s.label}.`);
      nav(`/projects/${pid}/apps/${app.id}`);
    } catch (err) { setErrors({ form: errMsg(err) }); setBusy(false); }
  }

  return (
    <Dialog title="Add an app" onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="add-app" className="btn btn-dark" disabled={busy}>{busy ? "Adding…" : "Add app"}</button>
    </>}>
      <form id="add-app" className="stack" onSubmit={submit} noValidate>
        <div className="choice" role="group" aria-label="Store">
          {CHOICES.map((c) => (
            <button key={c.type} type="button" aria-pressed={type === c.type} disabled={c.soon} aria-label={c.soon ? `${c.label} (soon)` : c.label} title={c.text}
              onClick={() => { setType(c.type); setErrors({}); if (c.type === "test_store" && !name) setName("Test Store"); }}>
              <Icon name={STORES[c.type]!.icon} /><span><b>{c.label}{c.soon && <span className="soon">SOON</span>}</b><small>{c.text}</small></span>
            </button>
          ))}
        </div>
        <Field label="App name" htmlFor="app-name" hint="Only you see this name. It helps tell your iOS and Android apps apart." error={errors.name}>
          <input id="app-name" className="input" maxLength={255} value={name} placeholder={({ play_store: "Scanner Android", amazon: "Scanner Fire", galaxy: "Scanner Galaxy", roku: "Scanner TV", stripe: "Scanner Web", paddle: "Scanner Web", test_store: "Test Store" } as Partial<Record<AppType, string>>)[type] ?? "Scanner iOS"}
            aria-invalid={!!errors.name} onChange={(e) => { setName(e.target.value); setErrors((x) => ({ ...x, name: undefined })); }} />
        </Field>
        {s.idField && (
          <Field label={s.idLabel!} htmlFor="app-store-id" error={errors.id}
            hint={s.idField === "bundle_id" ? "In Xcode: your target → General → Bundle Identifier." : type === "amazon" ? "In the Amazon Appstore Console: your app's package name, like com.company.app." : type === "galaxy" ? "In Samsung Seller Portal: your app's package name, like com.company.app." : "In Play Console: the id under your app's name, like com.company.app."}>
            <input id="app-store-id" className="input mono" value={id} placeholder="com.company.app" autoCapitalize="off" spellCheck={false}
              aria-invalid={!!errors.id} onChange={(e) => { setId(e.target.value); setErrors((x) => ({ ...x, id: undefined })); }} />
          </Field>
        )}
        {type === "paddle" && <p className="section-sub">Connect your Paddle account with an API key on the next page. Your backend posts each Paddle subscription or transaction, and Paddle's notifications keep it current.</p>}
        {type === "roku" && <p className="section-sub">Add your Roku Pay API key on the next page. The Roku SDK posts each purchase, and Roku's push notifications keep it current.</p>}
        {type === "stripe" && <p className="section-sub">Connect your own Stripe account with a restricted API key on the next page. Your backend posts each subscription or Checkout Session, and Stripe's webhooks keep it current.</p>}
        {type === "test_store" && <p className="section-sub">A Test Store app needs no store account. Use its key in a debug build to buy your products for free and see them here as sandbox purchases.</p>}
        {errors.form && <div className="banner err" role="alert">{errors.form}</div>}
      </form>
    </Dialog>
  );
}

export function Apps() {
  const pid = useProjectId();
  const nav = useNavigate();
  const apps = useApps(pid);
  const health = useSetupHealth(pid);
  // `?add` (or `?add=<store>`) opens Add app directly: the Overview checklist and empty states link here. The parameter is
  // removed once read, so Back from the new app (or a reload) does not open the dialog again.
  const [sp, setSp] = useSearchParams();
  const [adding, setAdding] = useState<AppType | null>(null);
  const addParam = sp.get("add");
  useEffect(() => {
    if (addParam === null) return;
    setAdding(ADDABLE.includes(addParam as AppType) ? addParam as AppType : "app_store");
    const n = new URLSearchParams(sp); n.delete("add"); setSp(n, { replace: true });
  }, [addParam]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasTest = apps.data?.some((a) => a.type === "test_store");
  const add = <button type="button" className="btn btn-dark" onClick={() => setAdding("app_store")}><Icon name="plus" />Add app</button>;

  return (
    <Shell title="Apps">
      <div className="page">
        <PageHead title="Apps" sub="Connect each store where your app sells. Every app gets its own public SDK key; products, entitlements and customers are shared across the project." actions={apps.data?.length ? add : undefined} />
        {apps.isLoading && <div className="panel pb subtle">Loading apps…</div>}
        {apps.isError && <div className="banner err" role="alert">The apps could not be loaded: {errMsg(apps.error)} <button type="button" className="linkish" onClick={() => apps.refetch()}>Try again</button></div>}
        {apps.data && !apps.data.length && (
          <div className="empty">
            <h3>Add your first app</h3>
            <p>Pick the store your app sells through. You will get a public SDK key and step-by-step setup for that store. No store account yet? Start with a Test Store app.</p>
            <div className="hrow" style={{ justifyContent: "center" }}>{add}<button type="button" className="btn btn-line" onClick={() => setAdding("test_store")}>Create Test Store app</button></div>
          </div>
        )}
        {!!apps.data?.length && (
          <div className="panel tbl">
            <table>
              {/* App ID and the store's bundle or package ID share one column, and Setup wraps, so the table fits from 1024px up. */}
              <thead><tr><th>Name</th><th>App ID · bundle ID</th><th>Public SDK key</th><th>Setup</th></tr></thead>
              <tbody>
                {apps.data.map((a) => {
                  const st = setupState(a, health.data?.apps.find((x) => x.id === a.id));
                  const sid = storeId(a);
                  return (
                    <tr key={a.id} className="row" tabIndex={0} onClick={() => nav(`/projects/${pid}/apps/${a.id}`)} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) nav(`/projects/${pid}/apps/${a.id}`); }}>
                      <td><StoreCell app={a} /></td>
                      <td className="id w2"><span className="appids" onClick={(e) => e.stopPropagation()}>
                        <span className="hrow">{a.id}<CopyButton value={a.id} label="Copy app ID" /></span>
                        {sid && <span className="hrow subtle">{sid}<CopyButton value={sid} label={`Copy ${(STORES[a.type]?.idLabel ?? "Bundle ID").replace(/^./, (c) => c.toLowerCase())}`} /></span>}
                      </span></td>
                      <td className="w2"><KeyCell pid={pid} appId={a.id} /></td>
                      <td className="w2 apps-setup"><span title={st.detail}><StatusLine tone={st.tone}>{st.text}</StatusLine></span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!!apps.data?.length && health.data && <SdkCompatibility list={health.data.sdk_versions} apps={apps.data} />}
        {apps.data && apps.data.length > 0 && !hasTest && (
          <section className="panel">
            <div className="ph"><b>Test without a store</b></div>
            <div className="pb hrow between">
              <p className="section-sub">A Test Store app lets you buy your own products for free, with no App Store or Google Play account. Test purchases show up as sandbox data.</p>
              <button type="button" className="btn btn-line" onClick={() => setAdding("test_store")}>Create Test Store app</button>
            </div>
          </section>
        )}
      </div>
      {adding && <AddAppDialog pid={pid} initial={adding} onClose={() => setAdding(null)} />}
    </Shell>
  );
}
