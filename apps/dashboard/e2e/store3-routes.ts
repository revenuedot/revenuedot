/**
 * Test-only routes on the e2e server that play Paddle, Roku and Samsung for stores3.spec.ts and manual browser checks:
 * make purchases and lifecycle changes in the in-process fakes (store-fakes.ts), and deliver the store's signed
 * notifications to the server's real notification URLs, exactly as the store would. Nothing here exists in RevenueDot.
 *   GET  /__store3/values                       the fake-only keys to paste into the dashboard
 *   POST /__store3/paddle/seed                   products and prices in the Paddle account
 *   POST /__store3/{paddle|roku|galaxy}/do       { action, ...args } → { ids, events }
 *   POST /__store3/{paddle|roku|galaxy}/deliver  { app_id, events, forged? } → the server's answers
 */
import type { Hono } from "hono";
import { FAKE_PADDLE_KEY, FAKE_PADDLE_LIMITED_KEY } from "../../../packages/contract/src/fake-paddle.ts";
import { FAKE_ROKU_KEY } from "../../../packages/contract/src/fake-roku.ts";
import { FAKE_GALAXY_ACCOUNT } from "../../../packages/contract/src/fake-galaxy.ts";
import { galaxyFake, paddleFake, rokuFake } from "./store-fakes.ts";

type Obj = Record<string, any>;

export function store3Routes(web: Hono, base: () => string, now: () => Date) {
  paddleFake.now = now; rokuFake.now = now; galaxyFake.now = now;

  web.get("/__store3/values", async (c) => {
    const k = await galaxyFake.keys();
    return c.json({
      paddle: { api_key: FAKE_PADDLE_KEY, limited_key: FAKE_PADDLE_LIMITED_KEY, secret: paddleFake.secret },
      roku: { api_key: FAKE_ROKU_KEY, channel_id: rokuFake.channelId, channel_name: rokuFake.channelName },
      galaxy: { package_name: galaxyFake.packageName, service_account_id: FAKE_GALAXY_ACCOUNT, private_key: k.serviceAccountPrivateKey, iap_public_key: k.iapPublicKey },
    });
  });

  web.post("/__store3/paddle/seed", async (c) => {
    const b = await c.req.json() as { products: Array<{ id?: string; name: string; prices: Array<{ id?: string; amount: number; interval?: "day" | "week" | "month" | "year" | null; trial_days?: number; name?: string }> }> };
    const out: Obj[] = [];
    for (const p of b.products) {
      const prod = paddleFake.products.get(p.id ?? "") ?? paddleFake.product({ id: p.id, name: p.name });
      for (const pr of p.prices) out.push(paddleFake.prices.get(pr.id ?? "") ?? paddleFake.price({ id: pr.id, product: prod.id, amount: pr.amount, interval: pr.interval ?? null, trialDays: pr.trial_days ?? null, name: pr.name }));
    }
    return c.json({ prices: out.map((p) => p.id) });
  });

  web.post("/__store3/:store/do", async (c) => {
    const b = await c.req.json() as Obj;
    const store = c.req.param("store");
    try {
      if (store === "paddle") {
        switch (b.action) {
          case "buy": { const r = paddleFake.buy(b.price, { customData: b.custom_data ?? null }); return c.json({ subscription_id: r.subscription?.id ?? null, transaction_id: r.transaction.id, events: r.events }); }
          case "renew": { const r = paddleFake.renew(b.subscription_id, { fail: !!b.fail }); return c.json({ transaction_id: r.transaction.id, events: r.events }); }
          case "recover": return c.json({ events: paddleFake.recover(b.subscription_id).events });
          case "schedule_cancel": return c.json({ events: paddleFake.scheduleCancel(b.subscription_id) });
          case "unschedule": return c.json({ events: paddleFake.unscheduleChange(b.subscription_id) });
          case "cancel_now": return c.json({ events: paddleFake.cancelNow(b.subscription_id) });
          case "pause": return c.json({ events: paddleFake.pause(b.subscription_id, b.resume_at ? new Date(b.resume_at) : null) });
          case "resume": return c.json({ events: paddleFake.resume(b.subscription_id).events });
          case "change_plan": return c.json({ events: paddleFake.changePlan(b.subscription_id, b.price).events });
          case "refund": { const r = paddleFake.refund(b.transaction_id, { partial: !!b.partial }); return c.json({ adjustment_id: r.adjustment.id, events: r.events }); }
        }
      }
      if (store === "roku") {
        switch (b.action) {
          case "buy": { const r = rokuFake.buy(b.product, { price: b.price, trialDays: b.trial_days, months: b.months }); return c.json({ transaction_id: r.transaction.transactionId, events: r.pushes }); }
          case "renew": { const r = rokuFake.renew(b.chain, b.type ?? "Sale"); return c.json({ transaction_id: r.transaction.transactionId, events: r.pushes }); }
          case "grace": return c.json({ events: rokuFake.grace(b.chain) });
          case "on_hold": return c.json({ events: rokuFake.onHold(b.chain) });
          case "cancel": return c.json({ events: rokuFake.cancel(b.chain) });
          case "resubscribe": return c.json({ events: rokuFake.resubscribe(b.chain) });
          case "refund": return c.json({ events: rokuFake.refund(b.transaction_id) });
          case "upgrade": { const r = rokuFake.upgrade(b.chain, b.product, b.price); return c.json({ transaction_id: r.transaction.transactionId, events: r.pushes }); }
        }
      }
      if (store === "galaxy") {
        switch (b.action) {
          case "subscribe": { const r = galaxyFake.subscribe(b.item, { amount: b.amount, trialDays: b.trial_days, test: !!b.test }); return c.json({ purchase_id: r.purchaseId, events: r.notifications }); }
          case "buy_item": { const r = galaxyFake.buyItem(b.item, { amount: b.amount, test: !!b.test }); return c.json({ purchase_id: r.purchaseId, events: r.notifications }); }
          case "renew": { const r = galaxyFake.renew(b.purchase_id); return c.json({ purchase_id: r.purchaseId, events: r.notifications }); }
          case "unsubscribe": return c.json({ events: galaxyFake.unsubscribe(b.purchase_id) });
          case "resubscribe": return c.json({ events: galaxyFake.resubscribe(b.purchase_id) });
          case "grace": return c.json({ events: galaxyFake.grace(b.purchase_id, b.days ?? 7) });
          case "refund": return c.json({ events: galaxyFake.refund(b.purchase_id) });
          case "up_downgrade": { const r = galaxyFake.upDowngrade(b.purchase_id, b.item, { amount: b.amount }); return c.json({ purchase_id: r.purchaseId, events: r.notifications }); }
          case "test": return c.json({ events: galaxyFake.test() });
          case "item": return c.json({ item: galaxyFake.item(b.id, b.title, b.usd_price) });
        }
      }
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
    return c.json({ error: `Unknown action ${String(b.action)} for ${store}` }, 400);
  });

  // Signs each event the way the store does and posts it to the server's notification URL for the app.
  web.post("/__store3/:store/deliver", async (c) => {
    const b = await c.req.json() as { app_id: string; events: Obj[]; forged?: boolean; secret?: string };
    const store = c.req.param("store");
    const results: Array<{ status: number; body: string }> = [];
    for (const ev of b.events) {
      let body: string, headers: Record<string, string>;
      if (store === "paddle") {
        const w = await paddleFake.sign(ev, { secret: b.forged ? "pdl_ntfset_forged" : b.secret });
        body = w.body; headers = { "content-type": "application/json", "paddle-signature": w.signature };
      } else if (store === "roku") {
        body = (await rokuFake.sign(ev, { forged: !!b.forged })).body; headers = { "content-type": "text/plain" };
      } else {
        const forgedKey = b.forged ? (await new (await import("../../../packages/contract/src/fake-galaxy.ts")).FakeGalaxy().keys()).iapPrivateKey : undefined;
        body = (await galaxyFake.sign(ev, { key: forgedKey })).body; headers = { "content-type": "text/plain" };
      }
      const res = await fetch(`${base()}/v1/notifications/${store}/${b.app_id}`, { method: "POST", headers, body });
      results.push({ status: res.status, body: await res.text() });
    }
    return c.json({ results });
  });
}
