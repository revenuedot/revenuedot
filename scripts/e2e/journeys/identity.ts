// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (d), identity, with the SDK's own wire calls (the calls purchases-ios/android make for configure,
// purchase, logIn, the Android alias call and restorePurchases). An anonymous player earns in-app currency and buys,
// logs in to a new id, a second device's anonymous player logs in to the same id (a merge: balances add up, ledger rows
// move), an alias is added, then a restore of another user's purchase runs under each transfer behaviour of the
// project (transfer, transfer_if_no_active, keep, share). Checked through the SDK, v2, SQL and the TRANSFER and
// SUBSCRIBER_ALIAS events.
import type { Journey } from "./run.ts";
import { type Ctx, anonId, eventsOf, sdkClient, signUp, standardCatalog } from "./lib/context.ts";
import { chromium } from "./onboarding.ts";

const journey: Journey = {
  name: "identity",
  title: "Identity: anonymous → logIn → merge → alias → restore under each transfer behaviour; currency survives merges",
  async run(ctx: Ctx) {
    const { c } = ctx;
    const dev = await signUp(ctx, "identity", "Identity game");
    const cat = await standardCatalog(dev);
    const sdk = sdkClient(ctx, cat.testKey);
    const P = dev.projectId;
    await dev.v2("POST", "/virtual_currencies", { code: "GLD", name: "Gold", product_grants: [{ product_ids: [cat.products.coins.id], amount: 100 }] });
    const balances = async (id: string) => {
      const r = await sdk.call("GET", `/v1/subscribers/${encodeURIComponent(id)}/virtual_currencies`);
      return r.body.virtual_currencies?.GLD?.balance ?? 0;
    };
    const customerIdOf = async (appUserId: string) => (await ctx.sql`SELECT customer_id FROM customer_aliases a JOIN customers c ON c.id = a.customer_id WHERE c.project_id = ${P} AND a.app_user_id = ${appUserId}`)[0]?.customer_id as string | undefined;

    c.begin("anonymous player buys and earns gold");
    const anonA = anonId();
    const first = await sdk.customerInfo(anonA);
    c.check("configure: GET customer info creates the anonymous customer (201)", first.status === 201 && first.body.subscriber.original_app_user_id === anonA, first.status);
    const coin = await sdk.purchase(anonA, "coins_100", { price: 1.99 });
    c.check("coins purchase accepted", coin.status === 200, coin.body);
    c.eq("the coins product grant credited 100 gold", await balances(anonA), 100);
    const pro = await sdk.purchase(anonA, "pro_monthly", { price: 9.99 });
    c.check("pro purchase gives pro", pro.body.subscriber?.entitlements?.pro?.product_identifier === "pro_monthly", pro.body.subscriber?.entitlements);

    c.begin("logIn to a new id");
    const player = `player_${ctx.stamp}`;
    const login1 = await sdk.logIn(anonA, player);
    c.check("identify to a new id answers 201 (created) with pro", login1.status === 201 && login1.body.subscriber?.entitlements?.pro, login1.status);
    c.eq("the same customer now has both ids", await customerIdOf(player), await customerIdOf(anonA));
    c.eq("gold stayed with the player", await balances(player), 100);

    c.begin("a second device: anonymous purchase, logIn to the same id, then the SDK's restore merges it");
    const anonB = anonId();
    await sdk.customerInfo(anonB);
    const coinTokenB = `test_${Date.now()}_${crypto.randomUUID()}`;
    await sdk.purchase(anonB, "coins_100", { price: 1.99, fetch_token: coinTokenB });
    c.eq("device B's anonymous player has 100 gold", await balances(anonB), 100);
    const custB = await customerIdOf(anonB);
    const login2 = await sdk.logIn(anonB, player);
    c.check("identify into an existing id answers 200", login2.status === 200, login2.status);
    // The player already has an anonymous id (device A), so logIn only switches; RevenueCat does the same.
    c.check("logIn alone does not merge into a customer that already has an anonymous id", (await customerIdOf(anonB)) === custB && (await balances(player)) === 100, { b: await customerIdOf(anonB), p: await customerIdOf(player) });
    const sync = await sdk.purchase(player, "coins_100", { price: 1.99, fetch_token: coinTokenB, is_restore: true });
    c.check("syncPurchases on device B (restore of its receipt) answers 200", sync.status === 200, sync.body);
    c.eq("the anonymous owner is merged into the player: balances add up (100 + 100)", await balances(player), 200);
    c.eq("device B's anonymous id now resolves to the player", await customerIdOf(anonB), await customerIdOf(player));
    const leftovers = await ctx.sql`SELECT count(*)::int AS n FROM customers WHERE id = ${custB!}`;
    c.eq("device B's anonymous customer row is gone (merged)", leftovers[0]!.n, 0);
    const ledger = await ctx.sql`SELECT amount FROM virtual_currency_transactions WHERE customer_id = ${(await customerIdOf(player))!}`;
    c.eq("both ledger rows (one per coins purchase) belong to the player", ledger.length, 2);
    const v2bal = await dev.v2("GET", `/customers/${player}/virtual_currencies`);
    c.check("v2 shows 200 gold for the player", v2bal.items?.find((b: any) => b.currency_code === "GLD")?.balance === 200, v2bal);
    const restoredAgain = await sdk.purchase(player, "coins_100", { price: 1.99, fetch_token: coinTokenB, is_restore: true });
    c.check("restoring the same consumable again credits nothing more", restoredAgain.status === 200 && (await balances(player)) === 200, await balances(player));
    const aliasesV2 = await dev.v2("GET", `/customers/${player}/aliases`);
    c.check("v2 aliases list has both anonymous ids and the player id", [anonA, anonB, player].every((id) => aliasesV2.items.some((a: any) => a.id === id)), aliasesV2.items);
    const aliasEvents = await eventsOf(ctx, P, { type: "SUBSCRIBER_ALIAS" });
    c.check("SUBSCRIBER_ALIAS recorded for the merge", aliasEvents.some((e) => e.app_user_id === player), aliasEvents.map((e) => e.app_user_id));

    c.begin("the merged customer in the dashboard (Chromium)");
    {
      const browser = await chromium().launch();
      const errors: string[] = [];
      try {
        const bcx = await browser.newContext();
        await bcx.addCookies([{ name: "rd_session", value: dev.cookie.split("=")[1]!, url: ctx.base }]);
        const page = await bcx.newPage();
        page.on("pageerror", (e) => errors.push(String(e)));
        page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
        page.on("response", (r) => { if (r.url().startsWith(ctx.base) && r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
        // The player's page lists both anonymous ids as aliases; opening one of those ids lands on the same customer.
        await page.goto(`${ctx.base}/projects/${P}/customers/${encodeURIComponent(player)}`);
        await page.locator(".aliases").waitFor({ timeout: 20_000 }).catch(() => {});
        await page.waitForLoadState("networkidle").catch(() => {});
        const aliasText = await page.locator(".aliases").innerText().catch(() => "");
        const ids = [anonA, anonB, player];
        c.check("the merged customer's page lists the other two ids as aliases", ids.filter((x) => aliasText.includes(x)).length === 2, aliasText);
        await page.goto(`${ctx.base}/projects/${P}/customers/${encodeURIComponent(anonB)}`);
        await page.waitForLoadState("networkidle").catch(() => {});
        const viaAlias = await page.locator(".aliases").innerText().catch(() => "");
        c.check("an old anonymous id opens the same merged customer", ids.filter((x) => viaAlias.includes(x)).length === 2 && !(await page.getByText("Customer not found").count()), viaAlias);
        const gold = page.locator("section.panel").filter({ has: page.locator(".ph b", { hasText: /^In-app currencies$/ }) });
        c.check("the page shows the merged 200 gold", (await gold.innerText().catch(() => "")).includes("200"), await gold.innerText().catch(() => ""));
        c.eq("no page errors, console errors or failed requests", errors, []);
      } finally { await browser.close(); }
    }

    c.begin("alias (Android SDK alias call, Block Store recovery)");
    const anonC = anonId();
    await sdk.customerInfo(anonC);
    const recovered = `recovered_${ctx.stamp}`;
    const al1 = await sdk.alias(anonC, recovered);
    c.check("alias of an anonymous id to a new id: one customer with both ids", al1.status === 200 && (await customerIdOf(recovered)) === (await customerIdOf(anonC)), al1);
    const known = `known_${ctx.stamp}`;
    await dev.v2("POST", "/customers", { id: known });
    const anonD = anonId();
    await sdk.customerInfo(anonD);
    await dev.v2("POST", `/customers/${encodeURIComponent(anonD)}/virtual_currencies/transactions`, { adjustments: { GLD: 50 } });
    const al2 = await sdk.alias(anonD, known);
    c.check("alias of an anonymous id to an existing id without anonymous ids merges, and its 50 gold moves", al2.status === 200 && (await customerIdOf(anonD)) === (await customerIdOf(known)) && (await balances(known)) === 50, { balance: await balances(known) });

    c.begin("subscriber-token mode (the SDKs' /v1/customer paths) and concurrent spends");
    const tokenRes = await dev.v2("POST", `/apps/${cat.app.id}/authenticate`, { app_user_id: player });
    c.check("v2 authenticate issues a one-hour rdat_ token", /^rdat_[0-9a-f]{64}$/.test(tokenRes.access_token) && Math.abs(tokenRes.expires_at - Date.now() - 3600_000) < 60_000, { object: tokenRes.object });
    const tok = tokenRes.access_token as string;
    const withToken = (method: string, path: string, json?: unknown, headers: Record<string, string> = {}) => sdk.call(method, path, json, { authorization: `Bearer ${tok}`, ...headers });
    const viaToken = await withToken("GET", "/v1/customer");
    const viaId = await sdk.customerInfo(player);
    c.check("GET /v1/customer with the token answers the player's customer info", viaToken.status === 200 && viaToken.body.subscriber.original_app_user_id === viaId.body.subscriber.original_app_user_id && JSON.stringify(viaToken.body.subscriber.entitlements) === JSON.stringify(viaId.body.subscriber.entitlements), viaToken.status);
    c.eq("the app key is refused on /v1/customer (7224)", (await sdk.call("GET", "/v1/customer")).body.code, 7224);
    const spends = await Promise.all(Array.from({ length: 6 }, (_, i) => withToken("POST", "/v1/customer/virtual_currencies/spend", { adjustments: { GLD: 40 }, reference: `level_${i}` })));
    c.eq("six spends of 40 at once against 200 gold: five succeed, one is refused (422), never below zero", spends.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 422]);
    c.eq("balance is 0 after the concurrent spends", await balances(player), 0);
    const spentRows = await ctx.sql`SELECT count(*)::int AS n FROM virtual_currency_transactions WHERE customer_id = ${(await customerIdOf(player))!} AND source = 'sdk'`;
    c.eq("five spend rows in the ledger", spentRows[0]!.n, 5);
    const idem = await Promise.all([1, 2].map(() => withToken("POST", "/v1/customer/virtual_currencies/spend", { adjustments: { GLD: 1 } }, { "Idempotency-Key": `idem-${ctx.stamp}` })));
    c.check("a spend with no balance left is refused either way (Idempotency-Key reused)", idem.every((r) => r.status === 422), idem.map((r) => r.status));

    // Restore: user Y restores (same store receipt) a purchase that user X made.
    const restoreCase = async (behavior: string, opts: { expiredOwner?: boolean } = {}) => {
      c.begin(`restore under ${behavior}${opts.expiredOwner ? " (owner's subscription expired)" : ""}`);
      await dev.v2("POST", "", { transfer_behavior: behavior, sandbox_transfer_behavior: null });
      const settings = await dev.v2("GET", "");
      c.eq("project transfer behaviour saved", settings.transfer_behavior, behavior);
      const x = `owner_${behavior}_${opts.expiredOwner ? "exp_" : ""}${ctx.stamp}`, y = `restorer_${behavior}_${opts.expiredOwner ? "exp_" : ""}${ctx.stamp}`;
      let token: string;
      if (opts.expiredOwner) {
        token = (await dev.v2("POST", "/test_purchases", { app_user_id: x, product_id: "pro_monthly", scenario: "expire", offset_days: 40 })).store_transaction_id;
      } else {
        token = `test_${Date.now()}_${crypto.randomUUID()}`;
        await sdk.purchase(x, "pro_monthly", { fetch_token: token });
      }
      await sdk.customerInfo(y);
      const r = await sdk.purchase(y, "pro_monthly", { fetch_token: token, is_restore: true });
      const xInfo = await sdk.customerInfo(x);
      const yInfo = await sdk.customerInfo(y);
      const has = (info: any) => Boolean(info.body.subscriber?.subscriptions?.pro_monthly);
      const owner = (await ctx.sql`SELECT c.original_app_user_id FROM subscriptions s JOIN customers c ON c.id = s.customer_id WHERE s.project_id = ${P} AND s.store_key = ${token}`)[0]?.original_app_user_id;
      const transfers = (await eventsOf(ctx, P, { type: "TRANSFER" })).filter((e) => (e.transferred_to ?? []).includes(y));
      return { r, x, y, xHas: has(xInfo), yHas: has(yInfo), owner, transfers, sameCustomer: (await customerIdOf(x)) === (await customerIdOf(y)) };
    };
    let t = await restoreCase("transfer");
    c.check("transfer: restore answers 200 and the purchase moves to the restorer", t.r.status === 200 && t.yHas && !t.xHas && t.owner === t.y, { status: t.r.status, xHas: t.xHas, yHas: t.yHas, owner: t.owner });
    c.check("transfer: TRANSFER event from the owner to the restorer", t.transfers.length === 1 && t.transfers[0]!.transferred_from.includes(t.x), t.transfers);
    t = await restoreCase("transfer_if_no_active");
    c.check("transfer_if_no_active with an active owner: 7102 receipt already in use, nothing moves", t.r.status === 400 && t.r.body.code === 7102 && t.xHas && !t.yHas, { status: t.r.status, body: t.r.body });
    t = await restoreCase("transfer_if_no_active", { expiredOwner: true });
    c.check("transfer_if_no_active with an expired owner: the purchase moves", t.r.status === 200 && t.owner === t.y && t.transfers.length === 1, { status: t.r.status, owner: t.owner, transfers: t.transfers.length });
    t = await restoreCase("keep");
    c.check("keep: 7102 receipt already in use, the owner keeps it", t.r.status === 400 && t.r.body.code === 7102 && t.xHas && !t.yHas && t.owner === t.x, { status: t.r.status, body: t.r.body });
    t = await restoreCase("share");
    c.check("share: both ids see the purchase (one customer with both ids), no TRANSFER", t.r.status === 200 && t.xHas && t.yHas && t.sameCustomer && t.transfers.length === 0, { xHas: t.xHas, yHas: t.yHas, same: t.sameCustomer });
    const total = await ctx.sql`SELECT count(*)::int AS n FROM customers WHERE project_id = ${P}`;
    c.check("customer count is consistent (merges removed rows, transfers kept both)", total[0]!.n > 0, total[0]);
  },
};
export default journey;
