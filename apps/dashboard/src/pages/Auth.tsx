import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useMe, type Me } from "../components/Shell";
import { Mark } from "../components/icons";

// Browsers read "/\host" and "/<tab>/host" as another site, so the path is checked by resolving it.
function sameSitePath(raw: string | null): string | null {
  if (!raw?.startsWith("/")) return null;
  try {
    const u = new URL(raw, window.location.origin);
    return u.origin === window.location.origin ? u.pathname + u.search + u.hash : null;
  } catch { return null; }
}

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  // Where to go after signing in (the invite page sends people here and back). Only paths on this site.
  const [params] = useSearchParams();
  const next = sameSitePath(params.get("next"));
  const [form, setForm] = useState({ email: params.get("email") ?? "", password: "", name: "", project_name: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signup = mode === "signup";
  // Self-hosted servers take only their owner's account unless REVENUEDOT_ALLOW_SIGNUP=true.
  // `sso` is only present when an enterprise extension offers single sign-on (src/extensions.tsx); `sso_error` comes back from it.
  const config = useQuery({ queryKey: ["auth-config"], queryFn: () => api<{ edition: string; signup: "open" | "closed"; signed_in?: boolean; sso?: boolean }>("/auth/config"), retry: false });
  const [ssoUrl, setSsoUrl] = useState<string | null>(null);
  const ssoError = params.get("sso_error");
  const closed = config.data?.signup === "closed";
  const cloud = config.data?.edition === "cloud";
  const me = useMe(config.data?.signed_in === true);
  useEffect(() => { document.title = `${signup ? "Create your account" : "Sign in"} · RevenueDot`; }, [signup]);
  // Keeps the destination when people switch between sign in, sign up and forgot password.
  const withNext = (path: string) => (next ? `${path}${path.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}` : path);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await api(signup ? "/auth/signup" : "/auth/login", { method: "POST", json: signup ? form : { email: form.email, password: form.password } });
      const me = await qc.fetchQuery({ queryKey: ["me"], queryFn: () => api<Me>("/auth/me") });
      nav(next ?? (me.projects[0] ? `/projects/${me.projects[0].id}/overview` : "/projects/new"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      // The address must sign in with single sign-on: offer its link.
      const b = err instanceof ApiError ? (err.body as { type?: string; sso_url?: string } | null) : null;
      if (b?.type === "sso_required" && b.sso_url?.startsWith("/")) setSsoUrl(b.sso_url);
    } finally { setBusy(false); }
  }
  /** Single sign-on: a full page load, because the identity provider answers with redirects. */
  const startSso = (url?: string | null) => {
    const email = form.email.trim();
    if (!url && !/^\S+@\S+\.\S+$/.test(email)) { setError("Enter your work email, then continue with SSO."); document.getElementById("email")?.focus(); return; }
    const target = new URL(url ?? `/sso/start?email=${encodeURIComponent(email)}`, window.location.origin);
    if (next) target.searchParams.set("next", next);
    window.location.assign(target.pathname + target.search);
  };
  // Invited people create their account on the invite page, which joins the project instead of creating an empty one.
  if (signup && next?.startsWith("/invite?")) return <Navigate to={next} replace />;
  // Already signed in: go where they were headed instead of showing the form again.
  if (me.data) return <Navigate to={next ?? (me.data.projects[0] ? `/projects/${me.data.projects[0].id}/overview` : "/projects/new")} replace />;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  if (signup && closed) {
    return (
      <main className="auth">
        <section className="auth-card" aria-labelledby="closed-h">
          <Mark size={36} />
          <div>
            <h1 id="closed-h">Sign-up is closed</h1>
            <p>This RevenueDot server already has its owner account, and it only lets the owner in.</p>
          </div>
          <p className="section-sub">Ask the owner for access. To let anyone who can reach this page create an account, the owner sets <code className="mono">REVENUEDOT_ALLOW_SIGNUP=true</code> in the server's <code className="mono">.env</code> and restarts it.</p>
          <Link className="btn btn-dark btn-lg" to={withNext("/login")}>Sign in</Link>
        </section>
      </main>
    );
  }
  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit} noValidate>
        <Mark size={36} />
        <div>
          <h1>{signup ? "Create your account" : "Sign in to RevenueDot"}</h1>
          <p>{signup ? (cloud ? "Subscriptions and in-app purchases for your apps. Free up to $10,000 a month in tracked revenue." : "Subscriptions and in-app purchases for your apps.") : "Welcome back."}</p>
        </div>
        {signup && <div className="field"><label htmlFor="name">Your name</label><input id="name" className="input" autoComplete="name" value={form.name} onChange={set("name")} /></div>}
        <div className="field"><label htmlFor="email">Email</label><input id="email" className="input" type="email" autoComplete="email" required value={form.email} onChange={set("email")} /></div>
        <div className="field"><div className="label-row"><label htmlFor="password">Password</label>{!signup && <Link to={withNext(`/forgot-password${form.email ? `?email=${encodeURIComponent(form.email)}` : ""}`)} className="label-link">Forgot password?</Link>}</div><input id="password" className="input" type="password" autoComplete={signup ? "new-password" : "current-password"} required minLength={8} value={form.password} onChange={set("password")} />{signup && <span className="hint">At least 8 characters.</span>}</div>
        {signup && <div className="field"><label htmlFor="project">First project</label><input id="project" className="input" placeholder="e.g. Scanner" value={form.project_name} onChange={set("project_name")} /><span className="hint">A project holds your apps, products and customers.</span></div>}
        {(error || ssoError) && <div className="banner err" role="alert">{error ?? ssoError}</div>}
        {ssoUrl && <button className="btn btn-line btn-lg" type="button" onClick={() => startSso(ssoUrl)}>Continue with SSO</button>}
        {signup && cloud && <p className="hint">We email you a link to confirm the address. By creating an account you agree to the <a href="https://revenuedot.app/legal/terms" target="_blank" rel="noopener" style={{ textDecoration: "underline" }}>Terms</a> and <a href="https://revenuedot.app/legal/privacy" target="_blank" rel="noopener" style={{ textDecoration: "underline" }}>Privacy Policy</a>.</p>}
        <button className="btn btn-dark btn-lg" type="submit" disabled={busy}>{busy ? "Please wait…" : signup ? "Create account" : "Sign in"}</button>
        {!signup && config.data?.sso && !ssoUrl && <button className="btn btn-line btn-lg" type="button" onClick={() => startSso()}>Continue with SSO</button>}
        <p>{signup ? <>Already have an account? <Link to={withNext("/login")} style={{ textDecoration: "underline" }}>Sign in</Link></> : closed ? "Sign-up is closed on this server." : <>New to RevenueDot? <Link to={withNext("/signup")} style={{ textDecoration: "underline" }}>Create an account</Link></>}</p>
      </form>
    </main>
  );
}
