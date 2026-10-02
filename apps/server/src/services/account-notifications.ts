import { and, eq, gte, inArray, or } from "drizzle-orm";
import { addPeriods, chartDef, DAY, detectAnomaly, floorTo, runChart, type AnomalyResult, type AnomalySensitivity, type ChartRequest } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { trySend, type Mailer } from "../mail/index.js";
import { anomalyEmail, experimentResultEmail, weeklySummaryEmail } from "../mail/templates.js";
import { linkBase, randomToken } from "./account-email.js";
import { sha256Hex } from "./auth.js";
import { chartSources, loadChartInput, type ChartSources } from "./charts/load.js";
import { experimentResults } from "./experiments.js";
import { fxLookup, type FxFetch } from "./fx.js";
import { hit } from "./rate-limit.js";

/**
 * Account notification emails (prd/account-settings/PRD.md §4), one step of the every-minute tick:
 *   weekly_summary          on the first day of each reader's week, the 7 days before (chart engine, weekly buckets)
 *   experiment_enough_data  an experiment first has 100 customers per variant
 *   experiment_ended        an experiment was stopped (within 7 days)
 *   revenue_anomaly         yesterday's revenue or new paid subscriptions against the 28 days before (daily, after 06:00 UTC)
 * Only for people who turned the kind on for a project they still belong to (notification_prefs). Each email is claimed
 * in notification_sends before it goes out, so overlapping ticks send it once, and carries a one-click unsubscribe link
 * (RFC 8058) for that kind and project. Each tick is bounded: at most `projects` analyses (summary, experiment and
 * anomaly computations), `emails` emails and `budgetMs` of work; the rest waits for the next tick. A running experiment
 * without enough data yet is analysed again at most once an hour, so a few of them cannot take every tick's analyses.
 */

export interface NotifyDeps { db: DB; mailer?: Mailer; publicUrl?: string; fetch?: FxFetch | null }
export const NOTIFY_LIMITS = { projects: 5, emails: 20, budgetMs: 15_000 };
/** Weekly summaries go out from this hour (UTC) of the week's first day, until the end of its third day. */
export const SUMMARY_FROM_HOUR = 6;
export const SUMMARY_WINDOW_DAYS = 3;
/** Anomaly checks run for yesterday from this hour (UTC). */
export const ANOMALY_FROM_HOUR = 6;
const ENDED_WITHIN_MS = 7 * DAY;
/** How often a running experiment that does not have enough data yet is analysed again. */
export const EXPERIMENT_RECHECK_MS = 3_600_000;

/** The preference each email kind turns off when its unsubscribe link is used. */
export const UNSUBSCRIBE_COLUMN = {
  weekly_summary: "weeklySummary", experiment_enough_data: "experimentResults", experiment_ended: "experimentResults", revenue_anomaly: "anomalyAlerts",
} as const;
export type NotificationKind = keyof typeof UNSUBSCRIBE_COLUMN;
/** The unsubscribe link of one email (routes/account.ts answers it without a session). */
export const unsubscribeUrl = (base: string, token: string) => `${base}/auth/notifications/unsubscribe/${token}`;

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Money, counts and changes as the emails show them. */
export function money(n: number, currency: string) {
  try { return n.toLocaleString("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }); } catch { return `${currency} ${n.toFixed(2)}`; }
}
const int = (n: number) => Math.round(n).toLocaleString("en-US");
export function change(cur: number, prev: number, kind: "money" | "count" | "points", currency = "USD") {
  const d = cur - prev;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
  const abs = Math.abs(d);
  const amount = kind === "money" ? money(abs, currency) : kind === "points" ? `${abs.toFixed(1)} pts` : int(abs);
  if (kind === "points" || prev === 0) return `${sign}${amount}`;
  return `${sign}${amount} (${sign}${(Math.abs(d / prev) * 100).toFixed(1)}%)`;
}

export interface WeekNumbers { mrr: number; revenue: number; newCustomers: number; newTrials: number; churned: number; churnRate: number | null }
export interface Digest { weekStart: number; currency: string; current: WeekNumbers; previous: WeekNumbers; empty: boolean }

const SUMMARY_CHARTS = ["mrr", "revenue", "customers_new", "trials_new", "churn"] as const;

function mergeSources(list: ChartSources[]): ChartSources {
  const sdk = [...new Set(list.flatMap((s) => s.sdkTypes))];
  const act = list.map((s) => s.activity).filter((x): x is NonNullable<typeof x> => !!x);
  return { sdkTypes: sdk, activity: act.length ? { from: act.map((a) => a.from).sort()[0]!, to: act.map((a) => a.to).sort().at(-1)! } : null, refundRequests: list.some((s) => s.refundRequests) };
}

/** The weekly summary's numbers for the week starting `weekStart` (ms) and the week before, from the chart engine. */
export async function weeklyDigest(deps: NotifyDeps, projectId: string, weekStart: number, weekStartDay: number, currency: string, now: Date): Promise<Digest> {
  const prevStart = addPeriods(weekStart, "week", -1);
  const end = addPeriods(weekStart, "week", 1);
  const sources = mergeSources(SUMMARY_CHARTS.map((n) => chartSources(n, { from: prevStart, to: end })));
  const input = await loadChartInput(deps.db, { projectId, sandbox: false, now, currency, fetch: deps.fetch ?? null, sources });
  const req: ChartRequest = { resolution: "week", rangeStart: prevStart, rangeEnd: end, expand: true, selectors: {}, weekStart: weekStartDay };
  const series = (name: string, measure: string) => {
    const out = runChart(chartDef(name)!, input, req).output;
    if (out.kind !== "series") return [null, null] as (number | null)[];
    const j = out.measures.findIndex((m) => m.id === measure);
    return [0, 1].map((k) => out.points[k]?.values[j] ?? null);
  };
  const mrr = series("mrr", "mrr"), rev = series("revenue", "revenue"), cust = series("customers_new", "new_customers"), trials = series("trials_new", "new_trials");
  const churned = series("churn", "churned_actives"), rate = series("churn", "churn_rate");
  const week = (k: 0 | 1): WeekNumbers => ({ mrr: mrr[k] ?? 0, revenue: rev[k] ?? 0, newCustomers: cust[k] ?? 0, newTrials: trials[k] ?? 0, churned: Math.abs(churned[k] ?? 0), churnRate: rate[k] ?? null });
  const previous = week(0), current = week(1);
  const empty = [previous, current].every((w) => !w.mrr && !w.revenue && !w.newCustomers && !w.newTrials && !w.churned);
  return { weekStart, currency, current, previous, empty };
}

/** The table rows and headline of a weekly summary email. */
export function digestRows(d: Digest): { rows: [string, string, string][]; headline: string } {
  const { current: c, previous: p, currency } = d;
  const rows: [string, string, string][] = [
    ["MRR", money(c.mrr, currency), change(c.mrr, p.mrr, "money", currency)],
    ["Revenue", money(c.revenue, currency), change(c.revenue, p.revenue, "money", currency)],
    ["New customers", int(c.newCustomers), change(c.newCustomers, p.newCustomers, "count")],
    ["New trials", int(c.newTrials), change(c.newTrials, p.newTrials, "count")],
    ["Churned subscriptions", int(c.churned), change(c.churned, p.churned, "count")],
    ["Churn rate", c.churnRate === null ? "—" : `${c.churnRate.toFixed(1)}%`, c.churnRate === null || p.churnRate === null ? "—" : change(c.churnRate, p.churnRate, "points")],
  ];
  const pct = p.mrr ? ((c.mrr - p.mrr) / p.mrr) * 100 : null;
  const headline = pct === null
    ? `MRR ended the week at ${money(c.mrr, currency)}, with ${money(c.revenue, currency)} of revenue.`
    : `MRR ${c.mrr >= p.mrr ? "grew" : "fell"} ${Math.abs(pct).toFixed(1)}% to ${money(c.mrr, currency)}, with ${money(c.revenue, currency)} of revenue this week.`;
  return { rows, headline };
}

export const weekLabel = (start: number) => {
  const last = new Date(start + 6 * DAY);
  const a = new Date(start).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const b = last.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `${a} – ${b}`;
};

/** Daily revenue (USD) and new paid subscriptions for the 28 days before `day` and the day itself, from the chart engine. */
export async function anomalyInput(deps: NotifyDeps, projectId: string, day: number, now: Date) {
  const from = day - 28 * DAY, to = day + DAY;
  const sources = mergeSources(["revenue", "actives_new"].map((n) => chartSources(n, { from, to })));
  const input = await loadChartInput(deps.db, { projectId, sandbox: false, now, currency: "USD", fetch: null, sources });
  const req: ChartRequest = { resolution: "day", rangeStart: from, rangeEnd: to, expand: true, selectors: {} };
  const daily = (name: string, measure: string) => {
    const out = runChart(chartDef(name)!, input, req).output;
    if (out.kind !== "series") return [];
    const j = out.measures.findIndex((m) => m.id === measure);
    return out.points.map((p) => p.values[j] ?? 0);
  };
  const rev = daily("revenue", "revenue"), subs = daily("actives_new", "new_paid");
  return {
    revenue: { history: rev.slice(0, -1), value: rev.at(-1) ?? 0 },
    new_subscriptions: { history: subs.slice(0, -1), value: subs.at(-1) ?? 0 },
  };
}
export type AnomalyInput = Awaited<ReturnType<typeof anomalyInput>>;

/** Each series judged at one sensitivity. */
export const judge = (input: AnomalyInput, s: AnomalySensitivity): AnomalyResult[] =>
  (["revenue", "new_subscriptions"] as const).map((k) => detectAnomaly(k, input[k].history, input[k].value, s));

export async function runAccountNotifications(deps: NotifyDeps, now: Date, limits = NOTIFY_LIMITS) {
  const { db } = deps;
  const t0 = Date.now();
  const out = { weekly: 0, experiments: 0, anomalies: 0, analysed: 0, deferred: 0 };
  let emails = 0;
  const canWork = () => out.analysed < limits.projects && emails < limits.emails && Date.now() - t0 < limits.budgetMs;
  const canSend = () => emails < limits.emails;
  const N = schema.notificationPrefs, M = schema.memberships, U = schema.users, P = schema.projects;
  const prefs = await db.select({ n: N, u: U, p: { id: P.id, name: P.name } }).from(N)
    .innerJoin(M, and(eq(M.userId, N.userId), eq(M.projectId, N.projectId)))
    .innerJoin(U, eq(U.id, N.userId)).innerJoin(P, eq(P.id, N.projectId))
    .where(or(eq(N.weeklySummary, true), eq(N.experimentResults, true), eq(N.anomalyAlerts, true)));
  if (!prefs.length) return out;
  const base = linkBase(deps);
  const S = schema.notificationSends;
  /**
   * Claims an email and returns its unsubscribe link, or null when another tick (or an earlier one) already claimed it.
   * The link's token is stored as a SHA-256 only.
   */
  const claim = async (userId: string, projectId: string, kind: NotificationKind, key: string) => {
    const token = randomToken();
    const won = await db.insert(S).values({ userId, projectId, kind, key, tokenHash: await sha256Hex(token), sentAt: now }).onConflictDoNothing().returning({ k: S.key });
    return won.length ? unsubscribeUrl(base, token) : null;
  };
  const sent = async (userId: string, projectId: string, kind: NotificationKind, key: string) =>
    (await db.select({ k: S.key }).from(S).where(and(eq(S.userId, userId), eq(S.projectId, projectId), eq(S.kind, kind), eq(S.key, key))).limit(1)).length > 0;
  const send = (to: string, mail: { subject: string; text: string; html: string }, unsubscribe: string) =>
    trySend(deps.mailer, { to, ...mail, headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
  // Exchange rates, loaded once per run. A currency without a rate shows USD, labelled USD, never USD amounts under
  // another currency's sign.
  let rates: Awaited<ReturnType<typeof fxLookup>> | undefined;
  const perUsd = async (currency: string, at: number) => (currency === "USD" ? 1 : ((rates ??= await fxLookup(db)).perUsd(currency, at)));
  const display = async (currency: string, at: number) => {
    const rate = await perUsd(currency, at);
    return rate ? { currency, conv: (usd: number) => usd * rate } : { currency: "USD", conv: (usd: number) => usd };
  };

  // 1. Weekly summaries: one computation per project, week and currency.
  const digests = new Map<string, Digest>();
  for (const { u, p } of prefs.filter((x) => x.n.weeklySummary)) {
    const thisWeek = floorTo(now.getTime(), "week", u.weekStart);
    const since = now.getTime() - thisWeek;
    if (since < SUMMARY_FROM_HOUR * 3_600_000 || since >= SUMMARY_WINDOW_DAYS * DAY) continue;
    const week = addPeriods(thisWeek, "week", -1);
    const key = iso(week);
    if (await sent(u.id, p.id, "weekly_summary", key)) continue;
    const currency = (await perUsd(u.displayCurrency, now.getTime())) ? u.displayCurrency : "USD";
    const dk = `${p.id}|${week}|${u.weekStart}|${currency}`;
    let d = digests.get(dk);
    if (!d) {
      if (!canWork()) { out.deferred++; continue; }
      out.analysed++;
      d = await weeklyDigest(deps, p.id, week, u.weekStart, currency, now);
      digests.set(dk, d);
    }
    if (!canSend()) continue;
    const unsubscribe = await claim(u.id, p.id, "weekly_summary", key);
    // A project with nothing in either week gets no email (the claim still records that the week was handled).
    if (!unsubscribe || d.empty) continue;
    const { rows, headline } = digestRows(d);
    emails++;
    if (await send(u.email, weeklySummaryEmail({ base, projectName: p.name, weekLabel: weekLabel(week), rows, headline, url: `${base}/projects/${p.id}/charts/mrr`, unsubscribeUrl: unsubscribe }), unsubscribe)) out.weekly++;
  }

  // 2. Experiment results: when one first has enough data, and when it ends.
  const expUsers = prefs.filter((x) => x.n.experimentResults);
  const expProjects = [...new Set(expUsers.map((x) => x.p.id))];
  if (expProjects.length) {
    const X = schema.experiments;
    const exps = await db.select().from(X).where(and(inArray(X.projectId, expProjects), or(inArray(X.status, ["running", "paused"]), and(eq(X.status, "stopped"), gte(X.stoppedAt, new Date(now.getTime() - ENDED_WITHIN_MS))))));
    for (const x of exps) {
      const readers = expUsers.filter((r) => r.p.id === x.projectId);
      const ended = x.status === "stopped";
      const kind = ended ? "experiment_ended" : "experiment_enough_data";
      const waiting = [];
      for (const r of readers) if (!(await sent(r.u.id, x.projectId, kind, x.id))) waiting.push(r);
      if (!waiting.length) continue;
      if (!canWork()) { out.deferred++; continue; }
      // Still running: analysed again at most once an hour until it has enough data.
      if (!ended && !(await hit(db, `notify:experiment:${x.id}`, 1, EXPERIMENT_RECHECK_MS, now))) continue;
      out.analysed++;
      const res = await experimentResults(db, x, "production");
      if (!ended && !res.enoughData) continue;
      for (const r of waiting) {
        if (!canSend()) continue;
        const unsubscribe = await claim(r.u.id, x.projectId, kind, x.id);
        if (!unsubscribe) continue;
        // An experiment that ended counts as read: no "enough data" email after the "ended" one.
        if (ended) await claim(r.u.id, x.projectId, "experiment_enough_data", x.id);
        const cur = await display(r.u.displayCurrency, now.getTime());
        const rows: [string, string, string][] = [res.a, res.b].map((v) => [`${v.id.toUpperCase()} (${v.customers} customers)`, `${(v.conversion_rate * 100).toFixed(1)}%`, money(cur.conv(v.revenue_per_customer), cur.currency)]);
        const chance = Math.round(res.chanceBBeatsA * 100);
        const verdict = chance >= 95 ? `B beats A on conversion with a ${chance}% chance.` : chance <= 5 ? `A beats B on conversion with a ${100 - chance}% chance.` : `No clear winner yet: B has a ${chance}% chance of beating A on conversion.`;
        emails++;
        const mail = experimentResultEmail({ base, projectName: r.p.name, experimentName: x.name, kind: ended ? "ended" : "enough_data", rows, verdict, url: `${base}/projects/${x.projectId}/experiments/${x.id}`, unsubscribeUrl: unsubscribe });
        if (await send(r.u.email, mail, unsubscribe)) out.experiments++;
      }
    }
  }

  // 3. Revenue anomalies for yesterday (UTC), once the day is over by ANOMALY_FROM_HOUR hours.
  const today = floorTo(now.getTime(), "day");
  if (now.getTime() - today >= ANOMALY_FROM_HOUR * 3_600_000) {
    const day = today - DAY, dayKey = iso(day);
    const watchers = prefs.filter((x) => x.n.anomalyAlerts);
    const projects = [...new Set(watchers.map((x) => x.p.id))];
    const A = schema.anomalyChecks;
    const checks = projects.length ? await db.select().from(A).where(and(eq(A.day, dayKey), inArray(A.projectId, projects))) : [];
    const byProject = new Map(checks.map((c) => [c.projectId, c.result as unknown as AnomalyInput]));
    for (const pid of projects) {
      const waiting = [];
      for (const w of watchers.filter((x) => x.p.id === pid)) if (!(await sent(w.u.id, pid, "revenue_anomaly", dayKey))) waiting.push(w);
      if (!waiting.length) continue;
      let input = byProject.get(pid);
      if (!input) {
        if (!canWork()) { out.deferred++; continue; }
        out.analysed++;
        input = await anomalyInput(deps, pid, day, now);
        await db.insert(A).values({ projectId: pid, day: dayKey, result: input as unknown as Record<string, unknown>, checkedAt: now }).onConflictDoNothing();
        byProject.set(pid, input);
      }
      for (const w of waiting) {
        const sens = (["low", "medium", "high"].includes(w.n.anomalySensitivity) ? w.n.anomalySensitivity : "medium") as AnomalySensitivity;
        const found = judge(input, sens).filter((r) => r.anomaly);
        if (!found.length || !canSend()) continue;
        const unsubscribe = await claim(w.u.id, pid, "revenue_anomaly", dayKey);
        if (!unsubscribe) continue;
        const cur = await display(w.u.displayCurrency, day);
        const lines = found.map((r) => {
          const what = r.series === "revenue" ? "Revenue" : "New paid subscriptions";
          const fmtv = (v: number) => (r.series === "revenue" ? money(cur.conv(v), cur.currency) : int(v));
          const pct = r.change === null ? "" : ` (${r.change > 0 ? "+" : "−"}${Math.abs(r.change * 100).toFixed(0)}%)`;
          return { title: `${what} ${r.direction === "down" ? "dropped" : "spiked"}`, text: `${fmtv(r.value)} on ${dayKey}, against a usual ${fmtv(r.median)} a day${pct}.` };
        });
        emails++;
        const chart = found[0]!.series === "revenue" ? "revenue" : "actives_new";
        if (await send(w.u.email, anomalyEmail({ base, projectName: w.p.name, day: dayKey, lines, sensitivity: sens, url: `${base}/projects/${pid}/charts/${chart}`, unsubscribeUrl: unsubscribe }), unsubscribe)) out.anomalies++;
      }
    }
  }
  return out;
}
