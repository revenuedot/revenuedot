import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Deps } from "../context.js";
import { SESSION_COOKIE, createSession, login, logout, projectsForUser, sessionUser, signup } from "../services/sessions.js";

const Signup = z.object({ email: z.string().email(), password: z.string().min(8), name: z.string().max(100).optional(), project_name: z.string().min(1).max(100).optional() });
const Login = z.object({ email: z.string().email(), password: z.string().min(1) });

/** Dashboard sign-in. The session cookie also authorizes /v2 for the user's projects. */
export function authRoutes(deps: Deps) {
  const r = new Hono();
  const cookieOpts = (secure: boolean) => ({ httpOnly: true, sameSite: "Lax" as const, secure, path: "/", maxAge: 30 * 86400 });
  const isHttps = (url: string) => url.startsWith("https:");

  r.post("/auth/signup", async (c) => {
    const p = Signup.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ type: "invalid_request", message: p.error.issues[0]?.message ?? "Invalid request." }, 400);
    const res = await signup(deps.db, { email: p.data.email, password: p.data.password, name: p.data.name, projectName: p.data.project_name ?? "My project" });
    if ("error" in res) return c.json({ type: "conflict", message: res.error }, 409);
    setCookie(c, SESSION_COOKIE, await createSession(deps.db, res.userId!, deps.now()), cookieOpts(isHttps(c.req.url)));
    return c.json({ ok: true }, 201);
  });

  r.post("/auth/login", async (c) => {
    const p = Login.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ type: "invalid_request", message: "Enter your email and password." }, 400);
    const u = await login(deps.db, p.data.email, p.data.password);
    if (!u) return c.json({ type: "authentication_error", message: "Email or password is incorrect." }, 401);
    setCookie(c, SESSION_COOKIE, await createSession(deps.db, u.id, deps.now()), cookieOpts(isHttps(c.req.url)));
    return c.json({ ok: true });
  });

  r.post("/auth/logout", async (c) => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid) await logout(deps.db, sid);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  r.get("/auth/me", async (c) => {
    const u = await sessionUser(deps.db, getCookie(c, SESSION_COOKIE), deps.now());
    if (!u) return c.json({ type: "authentication_error", message: "Not signed in." }, 401);
    return c.json({ user: { id: u.id, email: u.email, name: u.name }, projects: await projectsForUser(deps.db, u.id) });
  });
  return r;
}
