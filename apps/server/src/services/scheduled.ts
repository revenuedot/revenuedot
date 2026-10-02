import type { Deps } from "../context.js";
import { runBenchmarkJob } from "./benchmarks.js";
import { runInsightsDigest } from "./insights/digest.js";

/**
 * Scheduled work that needs the app's own dependencies (the model, the in-process API), run after the tick:
 * the nightly benchmark job (Cloud) and the weekly AI growth insights digest. Each is fenced off: an error is logged and
 * never stops the other. The Worker runs this from its cron only; the Node server from its interval.
 */
export async function runScheduledJobs(deps: Deps, now: Date) {
  const out: { benchmarks?: Awaited<ReturnType<typeof runBenchmarkJob>>; insights?: Awaited<ReturnType<typeof runInsightsDigest>> } = {};
  if (deps.benchmarks) {
    try { out.benchmarks = await runBenchmarkJob(deps, now, deps.benchmarkOptions); } catch (e) { console.error("scheduled: benchmarks failed", e); }
  }
  if (deps.insightsDigest && deps.assistant) {
    try { out.insights = await runInsightsDigest(deps, now); } catch (e) { console.error("scheduled: insights digest failed", e); }
  }
  return out;
}
