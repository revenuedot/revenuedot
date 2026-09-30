// Test server for the account email features: in-memory Postgres, an in-memory mailer, a clock the test moves, and
// background work (deferred sends) the test can wait for. Spec: prd/account-email/PRD.md
import { openDb, type DB } from "@revenuedot/db";
import { createApp } from "../src/app.js";
import type { Deps } from "../src/context.js";
import { memoryMailer } from "../src/mail/index.js";
import { defaultStores } from "../src/stores/index.js";

export interface Client {
  call: (method: string, path: string, json?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any; cookie: string | null }>;
  cookie: string | null;
}

export async function accountServer(over: Partial<Deps> = {}) {
  const o = await openDb("pglite://memory");
  const mail = memoryMailer();
  let clock = new Date("2026-09-30T12:00:00Z");
  const pending: Promise<unknown>[] = [];
  const deps: Deps = {
    db: o.db, now: () => clock, stores: defaultStores(), mailer: mail, publicUrl: "https://dash.example.com",
    defer: (task) => { pending.push(task()); }, ...over,
  };
  const app = createApp(deps);
  /** A browser: keeps its own session cookie. */
  const client = (): Client => {
    const c: Client = {
      cookie: null,
      async call(method, path, json, headers = {}) {
        const res = await app.fetch(new Request(`http://localhost${path}`, {
          method,
          headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(c.cookie ? { cookie: c.cookie } : {}), ...headers },
          body: json !== undefined ? JSON.stringify(json) : undefined,
        }));
        const set = res.headers.get("set-cookie");
        const m = set ? /rd_session=([^;]*)/.exec(set) : null;
        if (m) c.cookie = m[1] ? `rd_session=${m[1]}` : null;
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null, cookie: set };
      },
    };
    return c;
  };
  const settle = async () => { while (pending.length) await pending.shift(); };
  /** Signs up a new browser and returns it with the user's first project id. */
  const signup = async (email: string, extra: Record<string, unknown> = {}) => {
    const b = client();
    const r = await b.call("POST", "/auth/signup", { email, password: "correct horse battery", name: email.split("@")[0], project_name: "Scanner", ...extra });
    if (r.status !== 201) throw new Error(`signup ${email}: ${r.status} ${JSON.stringify(r.body)}`);
    await settle();
    const me = await b.call("GET", "/auth/me");
    return { browser: b, userId: me.body.user.id as string, projectId: me.body.projects[0]?.id as string | undefined };
  };
  /** The link in the last email to `to` that matches `path`. */
  const linkIn = (to: string, path: string) => {
    const m = [...mail.sent].reverse().find((x) => x.to === to && x.text.includes(path));
    if (!m) throw new Error(`no email to ${to} with ${path}; sent: ${mail.sent.map((x) => `${x.to}: ${x.subject}`).join(" | ")}`);
    const url = new RegExp(`https://dash\\.example\\.com${path.replace(/[?]/g, "\\?")}[^\\s]+`).exec(m.text)![0];
    return { url, token: decodeURIComponent(new URL(url).searchParams.get("token")!), message: m };
  };
  return {
    db: o.db as DB, deps, app, mail, client, signup, settle, linkIn, close: o.close,
    setNow: (d: Date) => { clock = d; }, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, now: () => clock,
  };
}
