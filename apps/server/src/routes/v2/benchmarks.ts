import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { inBackground } from "../../services/attribution.js";
import { benchmarksFor, computeProjectBenchmarks, isCategory, setBenchmarkSharing } from "../../services/benchmarks.js";
import { allows, body, paramError, scope, V2Error, type V2Context, type V2Router } from "./common.js";

/**
 * Benchmarks (prd/attribution-benchmarks-insights §2), RevenueDot extensions:
 *   GET  /v2/projects/{id}/benchmarks?category=&platform=&country=   the project's values and the peer percentiles
 *   GET  /v2/projects/{id}/benchmarks/settings                      { share, category }
 *   POST /v2/projects/{id}/benchmarks/settings                      { share, category } (admins; audited)
 * Cloud only: elsewhere GET answers `available: false` and POST is refused, so a self-hosted server never shares.
 */
const Settings = z.object({ share: z.boolean(), category: z.string().nullable().optional() });

export function benchmarkRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const B = "/v2/projects/:project_id/benchmarks";
  const settingsOf = async (projectId: string) => {
    const [p] = await db.select({ share: schema.projects.benchmarksShare, category: schema.projects.benchmarksCategory, sharedAt: schema.projects.benchmarksSharedAt })
      .from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
    return { object: "benchmark_settings", available: !!deps.benchmarks, share: !!p?.share, category: p?.category ?? null, shared_at: p?.sharedAt?.getTime() ?? null };
  };

  r.get(B, scope("charts_metrics:charts:read"), async (c) => {
    if (!deps.benchmarks) return c.json({ object: "benchmarks", available: false, reason: "Benchmarks are a RevenueDot Cloud feature. A self-hosted server shares nothing." });
    const q = (k: string) => c.req.query(k) || null;
    return c.json(await benchmarksFor(db, c.get("projectId"), { category: q("category"), platform: q("platform"), country: q("country")?.toUpperCase() ?? null }, deps.now(), { k: deps.benchmarkOptions?.k }));
  });

  r.get(`${B}/settings`, scope("project_configuration:projects:read"), async (c) => c.json(await settingsOf(c.get("projectId"))));

  r.post(`${B}/settings`, async (c: V2Context) => {
    const p = c.get("principal");
    if (p.kind === "user" ? p.via === "assistant" || p.role !== "admin" : !allows(p, "project_configuration:projects:read_write")) {
      throw new V2Error(403, "authorization_error", "Only project admins can change benchmark sharing.");
    }
    if (!deps.benchmarks) throw new V2Error(404, "resource_missing", "Benchmarks are a RevenueDot Cloud feature.");
    const b = await body(c, Settings);
    const category = b.category ?? null;
    if (b.share && !isCategory(category)) throw paramError("category: pick the app's category to share benchmarks.", "category");
    if (category !== null && !isCategory(category)) throw paramError("category is not one of the benchmark categories.", "category");
    const projectId = c.get("projectId");
    const before = await settingsOf(projectId);
    await setBenchmarkSharing(db, projectId, b.share, category, deps.now(), deps.benchmarkOptions);
    // The project sees its own values right away; it joins the peer groups at the next nightly run.
    if (b.share && !before.share) inBackground(deps, () => computeProjectBenchmarks(db, projectId, category!, deps.now(), deps.benchmarkOptions));
    return c.json(await settingsOf(projectId));
  });
}
