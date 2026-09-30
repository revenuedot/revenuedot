import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import type { Me } from "../components/Shell";
import { Mark } from "../components/icons";

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: "", password: "", name: "", project_name: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signup = mode === "signup";
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await api(signup ? "/auth/signup" : "/auth/login", { method: "POST", json: signup ? form : { email: form.email, password: form.password } });
      const me = await qc.fetchQuery({ queryKey: ["me"], queryFn: () => api<Me>("/auth/me") });
      nav(me.projects[0] ? `/projects/${me.projects[0].id}/overview` : "/projects/new");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally { setBusy(false); }
  }
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit} noValidate>
        <Mark size={36} />
        <div>
          <h1>{signup ? "Create your account" : "Sign in to RevenueDot"}</h1>
          <p>{signup ? "Subscriptions and in-app purchases for your apps. Free to self-host." : "Welcome back."}</p>
        </div>
        {signup && <div className="field"><label htmlFor="name">Your name</label><input id="name" className="input" autoComplete="name" value={form.name} onChange={set("name")} /></div>}
        <div className="field"><label htmlFor="email">Work email</label><input id="email" className="input" type="email" autoComplete="email" required value={form.email} onChange={set("email")} /></div>
        <div className="field"><label htmlFor="password">Password</label><input id="password" className="input" type="password" autoComplete={signup ? "new-password" : "current-password"} required minLength={8} value={form.password} onChange={set("password")} />{signup && <span className="hint">At least 8 characters.</span>}</div>
        {signup && <div className="field"><label htmlFor="project">First project</label><input id="project" className="input" placeholder="e.g. Scanner" value={form.project_name} onChange={set("project_name")} /><span className="hint">A project holds your apps, products and customers.</span></div>}
        {error && <div className="banner err" role="alert">{error}</div>}
        <button className="btn btn-dark btn-lg" type="submit" disabled={busy}>{busy ? "Please wait…" : signup ? "Create account" : "Sign in"}</button>
        <p>{signup ? <>Already have an account? <Link to="/login" style={{ textDecoration: "underline" }}>Sign in</Link></> : <>New to RevenueDot? <Link to="/signup" style={{ textDecoration: "underline" }}>Create an account</Link></>}</p>
      </form>
    </main>
  );
}
