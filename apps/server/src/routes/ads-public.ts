import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { parseAdMobCallback, parseRewardCustomData } from "@revenuedot/core/ads";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { KeysUnavailable, verifyAdMobCallback } from "../services/ads/admob-ssv.js";
import { recordReward } from "../services/ads/rewards.js";
import { AdMobError, finishAdMobConnect } from "../services/ads/admob.js";
import { depsSecretKey } from "../services/secrets.js";
import { publicOrigin } from "./oauth.js";

/**
 * Public ad endpoints (no API key; prd/ads/PRD.md), mounted before the SDK routes:
 *   GET /v1/ads/admob/ssv              AdMob's server-side verification callback (signed by Google)
 *   GET /v1/ads/admob/oauth/callback   Google's OAuth redirect after "Connect AdMob"
 */
export function adsPublicRoutes(deps: Deps) {
  const r = new Hono();
  const { db } = deps;

  r.get("/v1/ads/admob/ssv", async (c) => {
    const raw = new URL(c.req.url).search.slice(1);
    // AdMob's "Verify URL" button calls with no parameters and expects 200.
    if (!raw) return c.json({ ok: true });
    const cb = parseAdMobCallback(raw);
    if (!cb) return c.json({ error: "Expected AdMob's signed callback (signature and key_id last)." }, 400);
    let verdict: Awaited<ReturnType<typeof verifyAdMobCallback>>;
    try {
      verdict = await verifyAdMobCallback(cb, deps.fetch ?? fetch, deps.now().getTime());
    } catch (e) {
      // Google retries a callback that does not answer 200, so a key outage is not a lost reward.
      if (e instanceof KeysUnavailable) { console.warn(`AdMob SSV: ${e.message}`); return c.json({ error: "Google's verifier keys are unavailable; retry later." }, 503); }
      throw e;
    }
    if (verdict !== "ok") return c.json({ error: verdict === "unknown_key" ? "Unknown key_id." : "The signature is not valid." }, 403);
    const p = cb.params;
    const custom = parseRewardCustomData(p.custom_data);
    // Nothing to record without the SDK's token: answer 200 so Google stops retrying a callback that can never succeed.
    if (!custom) { console.warn("AdMob SSV: custom_data is not a RevenueDot reward verification token; ignored."); return c.json({ ok: true, recorded: false, reason: "invalid_custom_data" }); }
    const [app] = await db.select().from(schema.apps).where(eq(schema.apps.publicKey, custom.apiKey)).limit(1);
    if (!app) return c.json({ ok: true, recorded: false, reason: "unknown_api_key" });
    const ts = Number(p.timestamp);
    const now = deps.now();
    const amount = Number(p.reward_amount);
    await recordReward(db, {
      projectId: app.projectId, app: { id: app.id, type: app.type }, appUserId: p.user_id ?? "", clientTransactionId: custom.clientTransactionId,
      network: "admob", networkTransactionId: (p.transaction_id || `${custom.clientTransactionId}`).slice(0, 200), adUnitId: p.ad_unit?.slice(0, 200) || null,
      impressionId: custom.impressionId, rewardItem: p.reward_item?.slice(0, 200) || null, rewardAmount: Number.isFinite(amount) ? Math.trunc(amount) : null,
      occurredAt: Number.isFinite(ts) && ts > 1_420_070_400_000 && ts < now.getTime() + 86_400_000 ? new Date(ts) : now, isSandbox: app.type === "test_store", now,
    }, deps.kick);
    return c.json({ ok: true, recorded: true });
  });

  r.get("/v1/ads/admob/oauth/callback", async (c) => {
    const base = deps.publicUrl ?? publicOrigin(c);
    const state = c.req.query("state") ?? "";
    const projectId = state.split(".")[0] ?? "";
    const back = (q: string) => c.redirect(projectId && /^[A-Za-z0-9_-]+$/.test(projectId) ? `${base}/projects/${projectId}/integrations/admob?${q}` : `${base}/?${q}`, 302);
    const err = c.req.query("error");
    if (err || !c.req.query("code")) return back(`admob_error=${encodeURIComponent(err === "access_denied" ? "Google sign-in was cancelled." : "Google did not return an authorization code.")}`);
    try {
      await finishAdMobConnect({ db, fetch: deps.fetch ?? fetch, now: deps.now, secretKey: await depsSecretKey(deps), googleOAuth: deps.googleOAuth }, { state, code: c.req.query("code")! });
      return back("connected=1");
    } catch (e) {
      if (e instanceof AdMobError) return back(`admob_error=${encodeURIComponent(e.message)}`);
      throw e;
    }
  });

  return r;
}
