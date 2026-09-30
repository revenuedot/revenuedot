// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: checks shared by the iOS and Android device runs. They read the server's request log
// (REVENUEDOT_REQUEST_LOG, written by apps/server/src/entry.node.ts) to prove that the stock SDK made each call once,
// got the documented status (prd/sdk-api/PRD.md, "Endpoint inventory") and never hit an unrouted path or a 5xx, and
// they read the attributes the server stored. Docs: https://revenuedot.app/docs/sdks
import { existsSync, readFileSync } from "node:fs";

export type Check = { name: string; ok: boolean; detail?: unknown };
export interface LoggedRequest { at: number; method: string; path: string; query: string; status: number; routed: boolean }

export function readLog(file: string): LoggedRequest[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LoggedRequest);
}

/** The inventory template of a logged path: app user ids, transaction ids and other path values become placeholders. */
export function templateOf(path: string): string {
  return path
    .replace(/^\/v1\/subscribers\/(?!identify$|redeem_purchase$)[^/]+/, "/v1/subscribers/{app_user_id}")
    .replace(/^\/rcbilling\/v1\/subscribers\/[^/]+/, "/rcbilling/v1/subscribers/{app_user_id}")
    .replace(/^\/v1\/customercenter\/(?!support\/)[^/]+$/, "/v1/customercenter/{app_user_id}")
    .replace(/\/reward_verifications\/[^/]+$/, "/reward_verifications/{client_transaction_id}")
    .replace(/^\/v1\/receipts\/amazon\/.+$/, "/v1/receipts/amazon/{store_user_id}/{receipt_id}");
}

/** What one SDK call must look like in the log: how many times (exactly, or at least `min`) and with which statuses. */
export interface Expectation { method: string; template: string; count?: number; min?: number; statuses: number[]; why: string }

/** Only requests from the device: the runner's own REST calls (/v2, /auth) and its readiness probes are left out. */
const fromSdk = (r: LoggedRequest) => /^\/(v1|rcbilling)\//.test(r.path) && !(r.method === "GET" && r.path === "/v1/health");

export function requestChecks(log: LoggedRequest[], expectations: Expectation[]): Check[] {
  const sdk = log.filter(fromSdk);
  const checks: Check[] = [];
  const counts = new Map<string, { n: number; statuses: Set<number> }>();
  for (const r of sdk) {
    const k = `${r.method} ${templateOf(r.path)}`;
    const c = counts.get(k) ?? { n: 0, statuses: new Set<number>() };
    c.n++; c.statuses.add(r.status); counts.set(k, c);
  }
  checks.push({ name: "the SDK made calls the server logged", ok: sdk.length > 0, detail: Object.fromEntries([...counts].map(([k, v]) => [k, `${v.n}× ${[...v.statuses].join("/")}`])) });
  const unrouted = sdk.filter((r) => !r.routed);
  checks.push({ name: "no SDK call reached an unrouted path", ok: unrouted.length === 0, detail: unrouted.map((r) => `${r.method} ${r.path}`) });
  const failed = sdk.filter((r) => r.status >= 500);
  checks.push({ name: "no SDK call got a 5xx", ok: failed.length === 0, detail: failed.map((r) => `${r.method} ${r.path} ${r.status}`) });
  for (const e of expectations) {
    const hits = sdk.filter((r) => r.method === e.method && templateOf(r.path) === e.template);
    const countOk = e.count !== undefined ? hits.length === e.count : hits.length >= (e.min ?? 1);
    const statusOk = hits.every((r) => e.statuses.includes(r.status));
    checks.push({
      name: `${e.method} ${e.template}: ${e.count !== undefined ? `exactly ${e.count}×` : `at least ${e.min ?? 1}×`}, ${e.statuses.join(" or ")} (${e.why})`,
      ok: countOk && statusOk, detail: hits.map((r) => r.status),
    });
  }
  return checks;
}

/** Stored attributes must equal (a string) or match (a RegExp) the expected values. */
export function attributeChecks(stored: Record<string, string | null>, expected: Record<string, string | RegExp>, where: string): Check[] {
  return Object.entries(expected).map(([k, want]) => {
    const got = stored[k] ?? null;
    const ok = got !== null && (typeof want === "string" ? got === want : want.test(got));
    return { name: `${where}: ${k} is ${want}`, ok, detail: got };
  });
}
