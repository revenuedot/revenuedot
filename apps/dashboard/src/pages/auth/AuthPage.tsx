import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { CodeBlock, ConfirmDialog, Dialog, EmptyState, Field, Menu, PageHead, Segmented, Switch, Tag, useProjectId, useToast } from "../../components/ui";
import { api, fmt, type List } from "../../lib/api";
import { base, errMsg } from "../setup/data";
import "../settings/settings.css";

/**
 * Auth (/projects/:id/auth, prd/auth, RevenueCat frame 30): sign app users in with Firebase or any OpenID Connect provider
 * and link them to their subscriptions without a backend. RevenueCat shows a request-access page; this is the real
 * settings page: the project switch, providers, a token tester, sign-in snippets and recent identities.
 */

interface Settings { object: "auth_settings"; enabled: boolean; allow_anonymous: boolean }
interface Provider {
  object: "auth_provider"; id: string; kind: "firebase" | "oidc"; name: string; issuer: string; audiences: string[]; firebase_project_id: string | null;
  jwks_url: string | null; jwks_source: "configured" | "firebase" | "discovery"; app_user_id_claim: string; app_user_id_prefix: string; enabled: boolean; created_at: number;
}
interface Identity { object: "auth_identity"; provider_id: string; subject: string; app_user_id: string; logins: number; last_login_at: number; created_at: number }
interface TestResult { valid: boolean; subject: string | null; app_user_id: string | null; linked: boolean; claims: Record<string, unknown> | null; error: string | null }

const DOCS = "https://revenuedot.app/docs/guides/auth";
const apiOrigin = () => (location.hostname === "app.revenuedot.app" ? "https://api.revenuedot.app" : location.origin);

function ProviderDialog({ pid, initial, onClose }: { pid: string; initial: Provider | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<"firebase" | "oidc">(initial?.kind ?? "firebase");
  const [name, setName] = useState(initial?.name ?? "");
  const [fid, setFid] = useState(initial?.firebase_project_id ?? "");
  const [issuer, setIssuer] = useState(initial?.kind === "oidc" ? initial.issuer : "");
  const [aud, setAud] = useState(initial?.kind === "oidc" ? initial.audiences.join(", ") : "");
  const [jwks, setJwks] = useState(initial?.jwks_source === "configured" ? initial.jwks_url ?? "" : "");
  const [claim, setClaim] = useState(initial?.app_user_id_claim ?? "sub");
  const [prefix, setPrefix] = useState(initial?.app_user_id_prefix ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ param?: string; message: string } | null>(null);
  const err = (p: string) => (error?.param?.split(".")[0] === p ? error.message : null);
  const save = async () => {
    setBusy(true); setError(null);
    const json = {
      ...(initial ? {} : { kind }), ...(name.trim() ? { name: name.trim() } : {}), app_user_id_claim: claim.trim() || "sub", app_user_id_prefix: prefix.trim(),
      ...(kind === "firebase" ? { firebase_project_id: fid.trim() } : { issuer: issuer.trim(), audiences: aud.split(/[\s,]+/).filter(Boolean), jwks_url: jwks.trim() || null }),
    };
    try {
      await api(initial ? `${base(pid)}/auth/providers/${initial.id}` : `${base(pid)}/auth/providers`, { method: "POST", json });
      await qc.invalidateQueries({ queryKey: ["auth-providers", pid] });
      toast(initial ? "Provider saved." : "Provider added.");
      onClose();
    } catch (e) { setError({ param: (e as { body?: { param?: string } }).body?.param, message: errMsg(e) }); setBusy(false); }
  };
  return (
    <Dialog title={initial ? `Edit ${initial.name}` : "Add identity provider"} onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" disabled={busy} onClick={save}>{busy ? "Saving…" : initial ? "Save provider" : "Add provider"}</button>
    </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {!initial && <Segmented label="Provider type" value={kind} onChange={setKind} options={[{ value: "firebase", label: "Firebase" }, { value: "oidc", label: "OpenID Connect" }]} />}
        {kind === "firebase" ? (
          <Field label="Firebase project ID" htmlFor="ap-fid" hint="Firebase console › Project settings › General. Tokens must come from this project." error={err("firebase_project_id")}>
            <input id="ap-fid" className="input mono" autoFocus placeholder="my-app-1a2b3" value={fid} onChange={(e) => setFid(e.target.value)} />
          </Field>
        ) : <>
          <Field label="Issuer URL" htmlFor="ap-iss" hint="Exactly the iss claim of your ID tokens, such as https://your-tenant.auth0.com/ or https://accounts.google.com." error={err("issuer")}>
            <input id="ap-iss" className="input mono" autoFocus placeholder="https://" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
          </Field>
          <Field label="Audiences" htmlFor="ap-aud" hint="Client IDs your app's tokens are issued to (the aud claim), separated by commas." error={err("audiences")}>
            <input id="ap-aud" className="input mono" value={aud} onChange={(e) => setAud(e.target.value)} />
          </Field>
          <Field label="JWKS URL (optional)" htmlFor="ap-jwks" hint="Leave empty to read jwks_uri from the issuer's /.well-known/openid-configuration." error={err("jwks_url")}>
            <input id="ap-jwks" className="input mono" placeholder="https://" value={jwks} onChange={(e) => setJwks(e.target.value)} />
          </Field>
        </>}
        <div className="hrow" style={{ alignItems: "flex-start" }}>
          <Field label="App user ID claim" htmlFor="ap-claim" hint="sub is stable; email changes when the user changes it." error={err("app_user_id_claim")}>
            <input id="ap-claim" className="input mono" value={claim} onChange={(e) => setClaim(e.target.value)} style={{ width: 160 }} />
          </Field>
          <Field label="Prefix (optional)" htmlFor="ap-prefix" hint="Added in front, such as firebase:." error={err("app_user_id_prefix")}>
            <input id="ap-prefix" className="input mono" value={prefix} onChange={(e) => setPrefix(e.target.value)} style={{ width: 160 }} />
          </Field>
        </div>
        <p className="section-sub">Example: a user with {claim || "sub"} <code>abc123</code> signs in as app user ID <code>{prefix}abc123</code>. Users who already signed in keep their app user ID if you change this later.</p>
        <Field label="Name (optional)" htmlFor="ap-name"><input id="ap-name" className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        {error && !["firebase_project_id", "issuer", "audiences", "jwks_url", "app_user_id_claim", "app_user_id_prefix"].includes(error.param?.split(".")[0] ?? "") && <div className="banner err" role="alert">{error.message}</div>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function TestDialog({ pid, provider, onClose }: { pid: string; provider: Provider; onClose: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setError(null);
    try { setRes(await api<TestResult>(`${base(pid)}/auth/providers/${provider.id}/actions/test`, { method: "POST", json: { id_token: token.trim() } })); }
    catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog title={`Test a token for ${provider.name}`} onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Close</button>
      <button type="button" className="btn btn-dark" disabled={busy || !token.trim()} onClick={run}>{busy ? "Checking…" : "Check token"}</button>
    </>}>
      <div className="stack">
        <p className="section-sub">Paste an ID token from your app. It is checked exactly like a sign-in, but nobody is signed in and nothing is stored.</p>
        <Field label="ID token" htmlFor="tt-token"><textarea id="tt-token" className="textarea" rows={5} spellCheck={false} placeholder="eyJhbGciOi…" value={token} onChange={(e) => { setToken(e.target.value); setRes(null); }} /></Field>
        {error && <div className="banner err" role="alert">{error}</div>}
        {res && (res.valid ? (
          <div className="stack tight" role="status">
            <div className="banner ok"><Icon name="check" /><span>Valid. Signs in as <code>{res.app_user_id}</code>{res.linked ? " (already linked)" : ""}.</span></div>
            <pre className="au-claims">{JSON.stringify(res.claims, null, 2)}</pre>
          </div>
        ) : <div className="banner err" role="alert">Not accepted: {res.error}</div>)}
      </div>
    </Dialog>
  );
}

function snippets(origin: string) {
  return {
    curl: `# Sign in: exchange the provider's ID token for RevenueDot tokens (your public SDK key, never a secret key)
curl -X POST ${origin}/v1/auth/login \\
  -H "Authorization: Bearer <public SDK key>" -H "Content-Type: application/json" \\
  -d '{"method":"firebase","id_token":"<Firebase ID token>","link_to_id":"<current anonymous app user id>"}'

# Read what the signed-in user has
curl ${origin}/v1/customer -H "Authorization: Bearer <access_token>"
curl ${origin}/v1/customer/attributes -H "Authorization: Bearer <access_token>"
curl ${origin}/v1/customer/virtual_currencies -H "Authorization: Bearer <access_token>"`,
    swift: `// Firebase Auth → RevenueDot (no backend). Docs: ${DOCS}
let idToken = try await Auth.auth().currentUser!.getIDToken()
var req = URLRequest(url: URL(string: "${origin}/v1/auth/login")!)
req.httpMethod = "POST"
req.setValue("Bearer \\(publicSDKKey)", forHTTPHeaderField: "Authorization")
req.setValue("application/json", forHTTPHeaderField: "Content-Type")
req.httpBody = try JSONEncoder().encode(["method": "firebase", "id_token": idToken, "link_to_id": Purchases.shared.appUserID])
let (data, _) = try await URLSession.shared.data(for: req)
let tokens = try JSONDecoder().decode(Tokens.self, from: data)   // access_token, refresh_token, id_token, expires_in`,
    kotlin: `// Firebase Auth → RevenueDot (no backend). Docs: ${DOCS}
val idToken = Firebase.auth.currentUser!!.getIdToken(false).await().token!!
val body = JSONObject(mapOf("method" to "firebase", "id_token" to idToken, "link_to_id" to Purchases.sharedInstance.appUserID))
val request = Request.Builder().url("${origin}/v1/auth/login")
  .header("Authorization", "Bearer $publicSdkKey")
  .post(body.toString().toRequestBody("application/json".toMediaType())).build()
val tokens = JSONObject(client.newCall(request).execute().body!!.string())   // access_token, refresh_token, id_token`,
    js: `// Any OpenID Connect provider → RevenueDot (no backend). Docs: ${DOCS}
const res = await fetch("${origin}/v1/auth/login", {
  method: "POST",
  headers: { Authorization: \`Bearer \${PUBLIC_SDK_KEY}\`, "Content-Type": "application/json" },
  body: JSON.stringify({ method: "oidc", id_token: await getIdToken() }),
});
const { access_token, refresh_token } = await res.json();
const customer = await (await fetch("${origin}/v1/customer", { headers: { Authorization: \`Bearer \${access_token}\` } })).json();`,
  };
}

export function AuthPage() {
  const pid = useProjectId();
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ["auth-settings", pid], enabled: !!pid, queryFn: () => api<Settings>(`${base(pid)}/auth/settings`) });
  const providers = useQuery({ queryKey: ["auth-providers", pid], enabled: !!pid, queryFn: async () => (await api<List<Provider>>(`${base(pid)}/auth/providers?limit=100`)).items });
  const identities = useQuery({ queryKey: ["auth-identities", pid], enabled: !!pid, queryFn: async () => (await api<List<Identity>>(`${base(pid)}/auth/identities?limit=20`)).items });
  const [editing, setEditing] = useState<Provider | null | "new">(null);
  const [testing, setTesting] = useState<Provider | null>(null);
  const [deleting, setDeleting] = useState<Provider | null>(null);
  const [lang, setLang] = useState<"curl" | "swift" | "kotlin" | "js">("curl");
  const s = settings.data;
  const setS = async (patch: Partial<Settings>, msg: string) => {
    try { const r = await api<Settings>(`${base(pid)}/auth/settings`, { method: "POST", json: patch }); qc.setQueryData(["auth-settings", pid], r); toast(msg); }
    catch (e) { toast(errMsg(e)); }
  };
  const toggle = async (p: Provider) => {
    try { await api(`${base(pid)}/auth/providers/${p.id}`, { method: "POST", json: { enabled: !p.enabled } }); await qc.invalidateQueries({ queryKey: ["auth-providers", pid] }); toast(`${p.name} ${p.enabled ? "turned off" : "turned on"}.`); }
    catch (e) { toast(errMsg(e)); }
  };
  const nameOf = (id: string) => providers.data?.find((p) => p.id === id)?.name ?? id;
  const list = providers.data ?? [];
  const code = snippets(apiOrigin());

  return (
    <Shell title="Auth">
      <div className="page">
        <PageHead title="Auth" sub={<>Sign users in with Firebase or any OpenID Connect provider and link them to their subscriptions. <Tag tone="info">Beta</Tag></>} />

        <section className="au-hero" aria-labelledby="au-title">
          <div className="stack">
            <div>
              <h2 id="au-title">Skip building your own auth</h2>
              <p>Your app sends the ID token it already has. RevenueDot checks it with the provider's keys, signs the user in as their app user ID and hands back a token that reads their purchases, attributes and balances. No backend required.</p>
            </div>
            {settings.isError ? <div className="banner err" role="alert">{errMsg(settings.error)}</div> : (
              <div className="stack tight">
                <Switch checked={!!s?.enabled} disabled={!s} onChange={(v) => void setS({ enabled: v }, v ? "Auth is on." : "Auth is off. Sign-ins are refused.")} label={s?.enabled ? "Auth is on for this project" : "Auth is off for this project"} />
                <Switch checked={!!s?.allow_anonymous} disabled={!s} onChange={(v) => void setS({ allow_anonymous: v }, v ? "Anonymous sign-in allowed." : "Anonymous sign-in turned off.")} label="Allow anonymous sign-in" />
              </div>
            )}
          </div>
          <div className="au-flow" aria-hidden="true">
            <span>ID token</span><i /><span className="on"><b />RevenueDot</span><i /><span>app user ID</span>
          </div>
        </section>

        <div className="au-cards">
          {[
            ["auth", "Drop in your authentication provider", "Connect Firebase or any OpenID Connect provider. RevenueDot verifies tokens and maps each identity to an app user ID.", "#providers"],
            ["customers", "Read customer attributes in your app", "Attributes your app set through the SDK come back with the access token, so you can personalise without a round trip to your server.", "#attributes"],
            ["dollar", "Build on top of identity", "Read a signed-in user's in-app currency balances and entitlements from your backend by their provider user ID.", "#backend"],
          ].map(([icon, title, text, anchor]) => (
            <div key={title} className="card">
              <div className="card-h"><Icon name={icon!} /><b>{title}</b></div>
              <p>{text}</p>
              <a className="linkbtn" href={`${DOCS}${anchor}`} target="_blank" rel="noreferrer">Learn more →</a>
            </div>
          ))}
        </div>

        <section className="panel" id="providers">
          <div className="ph"><b>Identity providers</b><button type="button" className="btn btn-dark" onClick={() => setEditing("new")}><Icon name="plus" />Add provider</button></div>
          {providers.isLoading ? <div className="pb subtle">Loading…</div> : providers.isError ? <div className="pb"><div className="banner err" role="alert">{errMsg(providers.error)}</div></div> : !list.length ? (
            <div className="pb"><EmptyState title="No identity provider yet" text="Add Firebase or an OpenID Connect provider such as Auth0, Clerk, Supabase, Cognito, Google or Sign in with Apple." /></div>
          ) : (
            <div className="tbl">
              <table>
                <thead><tr><th>Provider</th><th className="hide-sm">Issuer</th><th className="hide-sm">App user ID</th><th>Status</th><th aria-label="Actions" /></tr></thead>
                <tbody>{list.map((p) => (
                  <tr key={p.id}>
                    <td><b>{p.name}</b><div className="subtle">{p.kind === "firebase" ? "Firebase" : "OpenID Connect"}</div></td>
                    <td className="hide-sm"><code>{p.issuer}</code><div className="subtle">Keys: {p.jwks_source === "configured" ? "JWKS URL" : p.jwks_source === "firebase" ? "Google's published keys" : "discovery"}</div></td>
                    <td className="hide-sm"><code>{p.app_user_id_prefix}{"{"}{p.app_user_id_claim}{"}"}</code></td>
                    <td><Tag tone={p.enabled ? "up" : "muted"}>{p.enabled ? "On" : "Off"}</Tag></td>
                    <td className="actions-cell"><Menu label={`Actions for ${p.name}`} items={[
                      { label: "Test a token", icon: "check", onSelect: () => setTesting(p) },
                      { label: "Edit", icon: "edit", onSelect: () => setEditing(p) },
                      { label: p.enabled ? "Turn off" : "Turn on", icon: "refresh", onSelect: () => void toggle(p) },
                      "-",
                      { label: "Delete", icon: "trash", danger: true, onSelect: () => setDeleting(p) },
                    ]} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {!!list.length && !s?.enabled && <div className="pb"><div className="banner warn" role="status">Auth is off, so these providers refuse every sign-in. Turn Auth on above.</div></div>}
        </section>

        <section className="panel" id="attributes">
          <div className="ph"><b>Sign in from your app</b><Segmented label="Language" value={lang} onChange={setLang} options={[{ value: "curl", label: "curl" }, { value: "swift", label: "Swift" }, { value: "kotlin", label: "Kotlin" }, { value: "js", label: "JavaScript" }]} /></div>
          <div className="pb stack">
            <p className="section-sub">Call <code>POST /v1/auth/login</code> with your app's <b>public</b> SDK key and the provider's ID token. The access token lasts one hour; refresh it with <code>POST /v1/auth/token</code> and sign out with <code>POST /v1/auth/revoke</code>. Pass the anonymous app user ID as <code>link_to_id</code> and purchases made before sign-in move to the user, like <code>logIn</code>.</p>
            <CodeBlock code={code[lang]} label={`${lang} sign-in snippet`} />
          </div>
        </section>

        <section className="panel" id="backend">
          <div className="ph"><b>Recent sign-ins</b><a className="link" href={`${DOCS}#backend`} target="_blank" rel="noreferrer">Backend API →</a></div>
          {identities.isLoading ? <div className="pb subtle">Loading…</div> : !(identities.data ?? []).length ? (
            <div className="pb"><p className="subtle">No one has signed in yet. Your backend can read a user's balances with <code>GET /v2/projects/{pid}/auth/identities/{"{provider_id}"}/{"{subject}"}</code> and a secret key.</p></div>
          ) : (
            <div className="tbl">
              <table>
                <thead><tr><th>App user ID</th><th className="hide-sm">Provider</th><th className="hide-sm">Subject</th><th>Last sign-in</th><th className="hide-sm" style={{ textAlign: "right" }}>Sign-ins</th></tr></thead>
                <tbody>{identities.data!.map((i) => (
                  <tr key={`${i.provider_id}/${i.subject}`}>
                    <td className="mono"><Link to={`/projects/${pid}/customers/${encodeURIComponent(i.app_user_id)}`}>{i.app_user_id}</Link></td>
                    <td className="hide-sm">{nameOf(i.provider_id)}</td>
                    <td className="hide-sm mono">{i.subject}</td>
                    <td>{fmt.ago(i.last_login_at)}</td>
                    <td className="hide-sm mono" style={{ textAlign: "right" }}>{fmt.int(i.logins)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      {editing && <ProviderDialog pid={pid} initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {testing && <TestDialog pid={pid} provider={testing} onClose={() => setTesting(null)} />}
      {deleting && <ConfirmDialog title={`Delete ${deleting.name}?`} confirmLabel="Delete provider" danger onClose={() => setDeleting(null)} onConfirm={async () => {
        await api(`${base(pid)}/auth/providers/${deleting.id}`, { method: "DELETE" });
        await Promise.all([qc.invalidateQueries({ queryKey: ["auth-providers", pid] }), qc.invalidateQueries({ queryKey: ["auth-identities", pid] })]);
        toast(`${deleting.name} deleted.`);
      }}>Everyone signed in through it is signed out, and its identity links are removed. Their app user IDs, purchases and balances stay.</ConfirmDialog>}
    </Shell>
  );
}
