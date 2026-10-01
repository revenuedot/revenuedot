// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the check recorder every journey writes to. A failed check is recorded and the journey goes on, so one run
// reports every broken case; `must` stops the journey when later steps cannot run without it.
import { isDeepStrictEqual } from "node:util";

export interface CheckResult { name: string; ok: boolean; detail?: unknown; at: number }

const scrub = (v: unknown): unknown => {
  // Never write a database URL or a full secret into results or logs.
  const s = JSON.stringify(v ?? null, (_k, x) => (typeof x === "string" ? x.replace(/postgres(ql)?:\/\/\S+/g, "postgres://…").replace(/\b(sk|rk|whsec|rdat|rdrt|rdrf)_[A-Za-z0-9_]{12,}/g, (m) => `${m.slice(0, 8)}…`).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "eyJ…(token)") : x));
  return s === undefined ? null : JSON.parse(s);
};

export class Checks {
  results: CheckResult[] = [];
  section = "";
  constructor(readonly journey: string) {}

  begin(section: string) { this.section = section; console.log(`\n  ${section}`); }

  check(name: string, ok: unknown, detail?: unknown): boolean {
    const full = this.section ? `${this.section}: ${name}` : name;
    const pass = Boolean(ok);
    this.results.push({ name: full, ok: pass, detail: pass ? undefined : scrub(detail), at: Date.now() });
    console.log(`    ${pass ? "PASS" : "FAIL"} ${name}${pass || detail === undefined ? "" : `\n         ${JSON.stringify(scrub(detail)).slice(0, 600)}`}`);
    return pass;
  }

  /** Deep equality, with both values in the failure detail. */
  eq(name: string, actual: unknown, expected: unknown): boolean {
    return this.check(name, isDeepStrictEqual(actual, expected), { actual, expected });
  }

  /** Every key of `expected` matches in `actual` (deep, recursive on objects). */
  has(name: string, actual: unknown, expected: Record<string, unknown>): boolean {
    const miss: string[] = [];
    const walk = (a: any, e: any, path: string) => {
      for (const [k, v] of Object.entries(e)) {
        const p = path ? `${path}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v)) walk(a?.[k], v, p);
        else if (!isDeepStrictEqual(a?.[k], v)) miss.push(`${p}: got ${JSON.stringify(a?.[k])}, want ${JSON.stringify(v)}`);
      }
    };
    walk(actual, expected, "");
    return this.check(name, miss.length === 0, miss);
  }

  /** A check the rest of the journey depends on: throws when it fails. */
  must(name: string, ok: unknown, detail?: unknown): void {
    if (!this.check(name, ok, detail)) throw new Error(`stopped: ${name}`);
  }

  get passed() { return this.results.filter((r) => r.ok).length; }
  get failed() { return this.results.filter((r) => !r.ok).length; }
}

/** Polls `fn` until it returns a truthy value or the time runs out (then returns the last value). */
export async function until<T>(fn: () => Promise<T>, { timeoutMs = 20_000, everyMs = 250 } = {}): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await fn();
    if (last || Date.now() > end) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
