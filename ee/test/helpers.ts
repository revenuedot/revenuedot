// RevenueDot Enterprise (ee/LICENSE). Test server: the real app on in-memory Postgres (PGlite) with the enterprise
// extension in development mode, a clock the test moves, an in-memory mailer and an injectable outbound fetch.
import { openPgliteDb } from "../../packages/contract/src/test-db.js";
import type { DB } from "@revenuedot/db";
import { createApp } from "../../apps/server/src/app.js";
import type { Deps } from "../../apps/server/src/context.js";
import { memoryMailer } from "../../apps/server/src/mail/index.js";
import { defaultStores } from "../../apps/server/src/stores/index.js";
import { tick } from "../../apps/server/src/services/tick.js";
import { enterpriseExtension } from "../server/index.js";
import { checkLicense } from "../server/license.js";
import type { RegionConfig } from "../server/region.js";
import type { ServerExtension } from "../../apps/server/src/extensions.js";

export interface Res { status: number; body: any; text: string; headers: Headers; cookie: string | null }
export interface Browser {
  cookie: string | null;
  call: (method: string, path: string, json?: unknown, headers?: Record<string, string>) => Promise<Res>;
  /** A form POST (SAML HTTP-POST binding). */
  form: (path: string, fields: Record<string, string>, headers?: Record<string, string>) => Promise<Res>;
}

export async function eeServer(o: { deps?: Partial<Deps>; extension?: ServerExtension | null; regions?: RegionConfig; fetch?: typeof fetch } = {}) {
  const opened = await openPgliteDb();
  const mail = memoryMailer();
  let clock = new Date();
  const pending: Promise<unknown>[] = [];
  const license = await checkLicense({ dev: true, now: Date.now() });
  const extension = o.extension === null ? null : o.extension ?? enterpriseExtension(license, o.regions);
  const deps: Deps = {
    db: opened.db, now: () => clock, stores: defaultStores(), mailer: mail, publicUrl: "https://dash.example.com",
    signingKey: "", encryptionKey: "ZTJlLWlkZW50aXR5LWtleS1mb3ItdGVzdHMtb25seSE=",
    fetch: o.fetch, defer: (task) => { pending.push(task()); }, extensions: extension ? [extension] : [], ...o.deps,
  };
  const app = createApp(deps);
  const browser = (): Browser => {
    const b: Browser = {
      cookie: null,
      async call(method, path, json, headers = {}) {
        return send(new Request(`https://dash.example.com${path}`, {
          method, redirect: "manual",
          headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(b.cookie ? { cookie: b.cookie } : {}), ...headers },
          body: json !== undefined ? JSON.stringify(json) : undefined,
        }));
      },
      async form(path, fields, headers = {}) {
        return send(new Request(`https://dash.example.com${path}`, {
          method: "POST", redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded", ...(b.cookie ? { cookie: b.cookie } : {}), ...headers },
          body: new URLSearchParams(fields).toString(),
        }));
      },
    };
    // A cookie jar like a browser's (rd_session and the SSO request binding rd_sso), ignoring paths.
    const jar = new Map<string, string>();
    const send = async (req: Request): Promise<Res> => {
      const res = await app.fetch(req);
      const set = res.headers.get("set-cookie");
      for (const sc of res.headers.getSetCookie()) {
        const pair = sc.split(";")[0]!, i = pair.indexOf("=");
        const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
        if (!value || /max-age=0\b/i.test(sc)) jar.delete(name); else jar.set(name, value);
      }
      b.cookie = jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join("; ") : null;
      const text = await res.text();
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { status: res.status, body, text, headers: res.headers, cookie: set };
    };
    return b;
  };
  const settle = async () => { while (pending.length) await pending.shift(); };
  /** Signs up a new account (with a first project) and returns its browser. */
  const signup = async (email: string, projectName = "Scanner") => {
    const b = browser();
    const r = await b.call("POST", "/auth/signup", { email, password: "correct horse battery", name: email.split("@")[0], project_name: projectName });
    if (r.status !== 201) throw new Error(`signup ${email}: ${r.status} ${r.text}`);
    await settle();
    const me = await b.call("GET", "/auth/me");
    return { browser: b, userId: me.body.user.id as string, projectId: me.body.projects[0]?.id as string };
  };
  /** Creates an organization owned by this browser's user and moves the given projects into it. */
  const createOrg = async (b: Browser, name: string, projectIds: string[] = []) => {
    const r = await b.call("POST", "/v2/organizations", { name });
    if (r.status !== 201) throw new Error(`create org: ${r.status} ${r.text}`);
    for (const p of projectIds) {
      const m = await b.call("POST", `/v2/organizations/${r.body.id}/projects`, { project_id: p });
      if (m.status !== 201 && m.status !== 200) throw new Error(`move project: ${m.status} ${m.text}`);
    }
    return r.body.id as string;
  };
  return {
    db: opened.db as DB, deps, app, mail, browser, signup, createOrg, settle, close: opened.close,
    tick: () => tick(opened.db, clock, o.fetch ?? fetch, { extensions: deps.extensions }),
    now: () => clock, setNow: (d: Date) => { clock = d; }, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
  };
}
export type EeServer = Awaited<ReturnType<typeof eeServer>>;
