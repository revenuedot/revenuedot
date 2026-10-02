// RevenueDot Enterprise (ee/LICENSE). Data location: each organization project records its region ("us" or "eu").
// On RevenueDot Cloud each region is its own deployment (Worker plus Postgres in that region); a request that reaches the
// wrong deployment is refused, never processed. Self-hosted servers run in the customer's own infrastructure, so the
// setting is recorded and nothing is enforced. Spec: prd/enterprise/PRD.md §8; what Cloud needs: docs/data-location.md.
import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { resolveKey } from "../../apps/server/src/services/auth.js";
import { eeOrgProjects } from "./schema.js";

export const REGIONS = ["us", "eu"] as const;
export type Region = (typeof REGIONS)[number];
export const REGION_NAMES: Record<Region, string> = { us: "United States", eu: "European Union" };

export interface RegionConfig {
  /** This deployment's region. */
  current: Region;
  /** Origins of every region that has a deployment. Empty: enforcement is off (self-host, or Cloud with one region). */
  regions: Partial<Record<Region, { api: string; app: string }>>;
}

/**
 * REVENUEDOT_REGION ("us" by default) and REVENUEDOT_REGIONS, JSON such as
 * {"us":{"api":"https://api.revenuedot.app","app":"https://app.revenuedot.app"},"eu":{"api":"https://api.eu.revenuedot.app","app":"https://app.eu.revenuedot.app"}}.
 */
export function regionConfigFrom(env: Record<string, string | undefined>): RegionConfig {
  const cur = (env.REVENUEDOT_REGION ?? "us").trim().toLowerCase();
  const current = (REGIONS as readonly string[]).includes(cur) ? (cur as Region) : "us";
  let regions: RegionConfig["regions"] = {};
  if (env.REVENUEDOT_REGIONS?.trim()) {
    try {
      const raw = JSON.parse(env.REVENUEDOT_REGIONS) as Record<string, { api?: string; app?: string }>;
      for (const r of REGIONS) {
        const v = raw[r];
        if (v?.api && v?.app) regions[r] = { api: v.api.replace(/\/+$/, ""), app: v.app.replace(/\/+$/, "") };
      }
    } catch {
      console.error("REVENUEDOT_REGIONS is not valid JSON; data location is not enforced.");
      regions = {};
    }
  }
  return { current, regions };
}

/** Whether the server routes by region: more than one region has a deployment. */
export const enforced = (cfg: RegionConfig) => Object.keys(cfg.regions).length > 1;

/** Regions a project may be set to here: every configured region on Cloud, both on a self-hosted server (recorded only). */
export const selectableRegions = (cfg: RegionConfig): Region[] => (enforced(cfg) ? REGIONS.filter((r) => cfg.regions[r]) : [...REGIONS]);

const cache = new Map<string, { at: number; region: Region | null }>();
const CACHE_MS = 60_000;

async function projectRegion(db: DB, projectId: string, nowMs: number): Promise<Region | null> {
  const hit = cache.get(projectId);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.region;
  const [row] = await db.select({ region: eeOrgProjects.region }).from(eeOrgProjects).where(eq(eeOrgProjects.projectId, projectId)).limit(1);
  const region = (row?.region as Region | undefined) ?? null;
  cache.set(projectId, { at: nowMs, region });
  return region;
}
export const forgetProjectRegion = (projectId: string) => cache.delete(projectId);

/**
 * Refuses requests for a project whose data lives in another region. API v2 and dashboard calls get 421 with the
 * right origin; SDK calls and store notifications get 503, so apps retry and stores redeliver instead of finishing a
 * purchase this deployment never recorded (AGENTS.md: temporary failures on receipts must be 5xx).
 */
export function regionGuard(db: DB, cfg: RegionConfig, now: () => Date): MiddlewareHandler {
  return async (c, next) => {
    if (!enforced(cfg)) return next();
    const path = new URL(c.req.url).pathname;
    let projectId: string | null = null;
    let sdk = false;
    const v2 = /^\/v2\/projects\/([^/]+)/.exec(path);
    if (v2) projectId = decodeURIComponent(v2[1]!);
    else if (path.startsWith("/v1/") || path.startsWith("/rcbilling/")) {
      sdk = true;
      const note = /^\/v1\/notifications\/[a-z]+\/([^/]+)/.exec(path);
      if (note) {
        const [app] = await db.select({ projectId: schema.apps.projectId }).from(schema.apps).where(eq(schema.apps.id, decodeURIComponent(note[1]!))).limit(1);
        projectId = app?.projectId ?? null;
      } else {
        const key = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
        if (key) projectId = (await resolveKey(db, key, now()).catch(() => null))?.projectId ?? null;
      }
    }
    if (!projectId) return next();
    const region = await projectRegion(db, projectId, now().getTime());
    if (!region || region === cfg.current) return next();
    const there = cfg.regions[region];
    const message = `This project's data is stored in the ${REGION_NAMES[region]} region${there ? `; use ${sdk ? there.api : there.app}` : ""}. This server does not process it.`;
    if (sdk) return c.json({ code: 7110, message }, 503, { "Retry-After": "60" });
    return c.json({ object: "error", type: "invalid_request", message, region, ...(there ? { api_url: there.api, app_url: there.app } : {}), doc_url: "https://revenuedot.app/docs/enterprise/data-location", retryable: false }, 421);
  };
}
