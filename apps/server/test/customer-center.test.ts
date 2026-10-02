import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { customerCenterConfigOf, customerCenterFor, customerCenterProblems } from "../src/services/customer-center.js";

/** Customer Center storage on Postgres (PGlite): what is stored, merged, validated and served (prd/customer-center/PRD.md). */

let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

const post = (json: unknown) => h.fetch("/v2/projects/proj1/customer_center_config", { method: "POST", key: h.ids.secretKey, json });
const stored = async () => (await h.db.select({ cc: schema.projects.customerCenter }).from(schema.projects).where(eq(schema.projects.id, "proj1")))[0]!.cc;

describe("Customer Center configuration storage", () => {
  it("stores the whole editor document, editor-only fields included, and serves the SDK shape from it", async () => {
    const config = await customerCenterConfigOf(h.db, "proj1");
    config.screens = {
      MANAGEMENT: { type: "MANAGEMENT", title: "How can we help?", title_localizations: { es: "¿Cómo podemos ayudarte?" }, paths: [
        { id: "p1", type: "CUSTOM_ACTION", title: "Open chat", action_identifier: "chat" },
        { id: "p2", type: "CANCEL", title: "Cancel", feedback_survey: { title: "Why?", options: [{ id: "o1", title: "Too expensive" }] } },
      ] },
      NO_ACTIVE: { type: "NO_ACTIVE", title: "Nothing", paths: [] },
    };
    expect((await post({ customer_center: config })).status).toBe(200);
    const row = await stored() as any;
    expect(row.screens.MANAGEMENT.title_localizations).toEqual({ es: "¿Cómo podemos ayudarte?" });
    expect(row.support.email).toBe(config.support && (config.support as any).email);

    const es = await customerCenterFor(h.db, "proj1", { preferredLocales: "es_MX" }) as any;
    expect(es.screens.MANAGEMENT.title).toBe("¿Cómo podemos ayudarte?");
    expect(es.screens.MANAGEMENT.paths.map((p: any) => p.id)).toEqual(["p1", "p2"]);
    expect(es.screens.NO_ACTIVE.paths).toEqual([]);
    expect(es.localization.locale).toBe("es_MX");
  });

  it("keeps editor paths when the Support page saves only the support settings", async () => {
    const config = await customerCenterConfigOf(h.db, "proj1") as any;
    config.screens.MANAGEMENT.paths = [{ id: "only", type: "MISSING_PURCHASE", title: "Restore" }];
    await post({ customer_center: config });
    // The Support page posts the stored overrides with its support fields changed.
    const overrides = await stored() as any;
    await post({ customer_center: { ...overrides, support: { ...overrides.support, email: "tickets@scanner.app", support_tickets: { allow_creation: true, customer_type: "all", customer_details: { idfv: true } } } } });
    const sdk = await customerCenterFor(h.db, "proj1") as any;
    expect(sdk.screens.MANAGEMENT.paths.map((p: any) => p.id)).toEqual(["only"]);
    expect(sdk.support).toMatchObject({ email: "tickets@scanner.app", support_tickets: { allow_creation: true, customer_type: "all" } });
  });

  it("puts Retention offers only on cancel and refund paths that have no offer of their own", async () => {
    const offer = await h.fetch("/v2/projects/proj1/retention_offers", { method: "POST", key: h.ids.secretKey, json: { trigger: "cancel", name: "Discount", title: "Stay for 50% off", store: "app_store", product_mapping: { pro_monthly: "stay_50" } } });
    expect(offer.status).toBe(201);
    let sdk = await customerCenterFor(h.db, "proj1") as any;
    expect(sdk.screens.MANAGEMENT.paths.find((p: any) => p.type === "CANCEL").promotional_offer.title).toBe("Stay for 50% off");

    const config = await customerCenterConfigOf(h.db, "proj1") as any;
    config.screens.MANAGEMENT.paths[0].promotional_offer = { title: "Our own offer", product_mapping: { pro_monthly: "own" } };
    await post({ customer_center: config });
    sdk = await customerCenterFor(h.db, "proj1") as any;
    expect(sdk.screens.MANAGEMENT.paths.find((p: any) => p.type === "CANCEL").promotional_offer).toMatchObject({ title: "Our own offer", ios_offer_id: "own" });
  });

  it("resolves Retention offer references, keeps \"no offer\" off the path, and rejects unknown offers", async () => {
    const mk = async (json: unknown) => (await (await h.fetch("/v2/projects/proj1/retention_offers", { method: "POST", key: h.ids.secretKey, json })).json() as any).id as string;
    const cancelId = await mk({ trigger: "cancel", name: "Half", title: "Half price", store: "app_store", product_mapping: { pro_monthly: "half" } });
    const refundId = await mk({ trigger: "refund", name: "Month", title: "A free month", store: "play_store", product_mapping: { "pro:monthly": "free-month" } });
    const config = await customerCenterConfigOf(h.db, "proj1") as any;
    const cancel = config.screens.MANAGEMENT.paths.find((p: any) => p.type === "CANCEL");
    cancel.promotional_offer = null;
    cancel.feedback_survey = { title: "Why?", options: [{ id: "o1", title: "Too expensive", promotional_offer: { retention_offer_id: refundId } }] };
    config.screens.MANAGEMENT.paths.find((p: any) => p.type === "REFUND_REQUEST").promotional_offer = { retention_offer_id: cancelId };
    expect((await post({ customer_center: config })).status).toBe(200);
    let sdk = await customerCenterFor(h.db, "proj1") as any;
    const paths = sdk.screens.MANAGEMENT.paths;
    expect(paths.find((p: any) => p.type === "CANCEL").promotional_offer).toBeUndefined();
    expect(paths.find((p: any) => p.type === "CANCEL").feedback_survey.options[0].promotional_offer).toMatchObject({ title: "A free month", android_offer_id: "free-month", product_mapping: { "pro:monthly": "free-month" } });
    expect(paths.find((p: any) => p.type === "REFUND_REQUEST").promotional_offer).toMatchObject({ title: "Half price", ios_offer_id: "half" });

    // Deleting the offer removes it from the path instead of breaking the SDK response.
    expect((await h.fetch(`/v2/projects/proj1/retention_offers/${cancelId}`, { method: "DELETE", key: h.ids.secretKey })).status).toBeLessThan(300);
    sdk = await customerCenterFor(h.db, "proj1") as any;
    expect(sdk.screens.MANAGEMENT.paths.find((p: any) => p.type === "REFUND_REQUEST").promotional_offer).toBeUndefined();
    // A new reference to an offer that does not exist is refused (the stored, now deleted one stays allowed).
    config.screens.MANAGEMENT.paths.find((p: any) => p.type === "REFUND_REQUEST").promotional_offer = { retention_offer_id: "ro_unknown" };
    const res = await post({ customer_center: config });
    expect(res.status).toBe(400);
    expect((await res.json() as any).message).toMatch(/retention_offer_id: no Retention offer/);
  });

  it("validates the stored overrides merged over the default, and resets with null", async () => {
    expect(await customerCenterProblems(h.db, "proj1", { screens: { NO_ACTIVE: { paths: [{ id: "x", type: "CUSTOM_URL", title: "Site", url: "ftp//nope" }] } } }))
      .toEqual(["screens.NO_ACTIVE.paths[0].url: needs a full URL, such as https://example.com/help or myapp://support."]);
    expect(await customerCenterProblems(h.db, "proj1", { screens: { NO_ACTIVE: { title: "Nothing yet" } } })).toEqual([]);
    const res = await post({ customer_center: { appearance: { light: { accent_color: "#zzzzzz" } } } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ object: "error", type: "parameter_error", param: "customer_center" });
    expect(await stored()).toBeNull();
    await post({ customer_center: { support: { email: "a@b.co" } } });
    expect(await stored()).toEqual({ support: { email: "a@b.co" } });
    await post({ customer_center: null });
    expect(await stored()).toBeNull();
    expect(((await customerCenterFor(h.db, "proj1")) as any).screens.MANAGEMENT.title).toBe("Manage subscription");
  });
});

/**
 * Documents stored before the editor (the old screen-texts editor, the old Support page and plain API v2 POSTs) must keep
 * serving the response they served before. `oldResponse` is the previous server code: the default with the stored
 * overrides merged in, then the Retention offers on cancel and refund paths without an offer.
 */
describe("Customer Center documents stored before the editor", () => {
  const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
  const merge = (b: Record<string, any>, o: Record<string, any>): Record<string, any> => {
    const out = { ...b };
    for (const [k, v] of Object.entries(o)) out[k] = isObj(v) && isObj(b[k]) ? merge(b[k], v) : v;
    return out;
  };
  const OLD_STRINGS = {
    no_thanks: "No, thanks", restore_purchases: "Restore purchases", cancel: "Cancel", contact_support: "Contact support",
    manage_subscription: "Manage your subscription", check_past_purchases: "Check past purchases", dismiss: "Dismiss", done: "Done",
    no_subscriptions_found: "No subscriptions found", default_subject: "Support request", default_body: "Please describe your issue or question.",
  };
  const oldDefault = (email: string) => ({
    appearance: { light: {}, dark: {} },
    screens: {
      MANAGEMENT: { type: "MANAGEMENT", title: "Manage subscription", subtitle: "Choose what you want to do.", paths: [
        { id: "path_cancel", title: "Cancel subscription", type: "CANCEL" }, { id: "path_refund", title: "Request a refund", type: "REFUND_REQUEST" },
        { id: "path_missing", title: "Missing purchase", type: "MISSING_PURCHASE" }] },
      NO_ACTIVE: { type: "NO_ACTIVE", title: "No active subscriptions", subtitle: "We could not find an active subscription for this account.", paths: [{ id: "path_missing_none", title: "Restore purchases", type: "MISSING_PURCHASE" }] },
    },
    localization: { locale: "en_US", localized_strings: OLD_STRINGS },
    support: { email, should_warn_customer_to_update: false, display_purchase_history_link: true, display_user_details_section: true, display_virtual_currencies: false },
    change_plans: [],
  });
  const store = (cc: unknown) => h.db.update(schema.projects).set({ customerCenter: cc as any }).where(eq(schema.projects.id, "proj1"));
  /** The previous response, with the two intended differences applied: empty subtitles are left out, ticket detail keys are snake_case. */
  const oldResponse = async (offer: Record<string, unknown> | null = null) => {
    const base = oldDefault((await customerCenterConfigOf(h.db, "proj1") as any).support.email);
    const out = merge(base, (await stored()) as any ?? {});
    for (const s of Object.values(out.screens) as any[]) {
      if (s.subtitle === "") delete s.subtitle;
      if (offer) s.paths = s.paths.map((p: any) => (p.type === "CANCEL" && p.promotional_offer === undefined ? { ...p, promotional_offer: offer } : p));
    }
    const t = out.support.support_tickets;
    if (t?.customer_details) t.customer_details = Object.fromEntries(Object.entries(t.customer_details).map(([k, v]) => [k === "ipAddress" ? "ip" : k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));
    return out;
  };

  it("serves a document of the old screen-texts editor as before, in English and with no language header", async () => {
    await store({
      support: { email: "help@scanner.app", display_purchase_history_link: false, display_user_details_section: true, should_warn_customer_to_update: true },
      screens: { MANAGEMENT: { title: "Your plan", subtitle: "Pick one" }, NO_ACTIVE: { title: "Nothing here", subtitle: "" } },
    });
    const now = await customerCenterFor(h.db, "proj1");
    expect(now).toEqual(await oldResponse());
    expect(await customerCenterFor(h.db, "proj1", { preferredLocales: "en_US" })).toEqual(now);
    // The editor opens it with the old texts and the default paths.
    const cfg = await customerCenterConfigOf(h.db, "proj1") as any;
    expect(cfg.screens.MANAGEMENT).toMatchObject({ title: "Your plan", subtitle: "Pick one", paths: [{ id: "path_cancel" }, { id: "path_refund" }, { id: "path_missing" }] });
    expect(await customerCenterProblems(h.db, "proj1", cfg)).toEqual([]);
  });

  it("serves the old Support page's ticket settings with the keys the SDKs read, and keeps them on save", async () => {
    await store({ support: { email: "help@scanner.app", support_tickets: { allow_creation: true, customer_type: "active", customer_details: { appUserId: false, totalSpent: true, ipAddress: true, idfv: true } } } });
    const now = await customerCenterFor(h.db, "proj1") as any;
    expect(now).toEqual(await oldResponse());
    expect(now.support.support_tickets).toEqual({ allow_creation: true, customer_type: "active", customer_details: { app_user_id: false, total_spent: true, ip: true, idfv: true } });
    // The editor saves the stored values untouched (the server still reads camelCase for ticket emails).
    const cfg = await customerCenterConfigOf(h.db, "proj1") as any;
    expect((await post({ customer_center: cfg })).status).toBe(200);
    expect((await stored() as any).support.support_tickets.customer_details).toEqual({ appUserId: false, totalSpent: true, ipAddress: true, idfv: true });
  });

  it("serves an API document with its own paths, offer and strings as before, and adds Retention offers where it did", async () => {
    const own = { ios_offer_id: "stay", android_offer_id: "stay", eligible: true, title: "Stay", subtitle: "50% off", product_mapping: { pro: "stay" } };
    await store({
      screens: { MANAGEMENT: { paths: [
        { id: "p_cancel", title: "Cancel", type: "CANCEL" },
        { id: "p_refund", title: "Refund", type: "REFUND_REQUEST", promotional_offer: own },
        { id: "p_url", title: "Help", type: "CUSTOM_URL", url: "https://scanner.app/help", open_method: "IN_APP" },
      ] } },
      localization: { localized_strings: { contact_support: "Write to us" } },
    });
    await h.fetch("/v2/projects/proj1/retention_offers", { method: "POST", key: h.ids.secretKey, json: { trigger: "cancel", name: "Discount", title: "A month free", store: "app_store", product_mapping: { pro: "free" } } });
    const now = await customerCenterFor(h.db, "proj1");
    expect(now).toEqual(await oldResponse({ ios_offer_id: "free", android_offer_id: "", eligible: true, title: "A month free", subtitle: "", product_mapping: { pro: "free" } }));
  });

  it("keeps saving other settings after a referenced Retention offer is deleted, but refuses new unknown references", async () => {
    const id = (await (await h.fetch("/v2/projects/proj1/retention_offers", { method: "POST", key: h.ids.secretKey, json: { trigger: "cancel", name: "D", title: "Stay", store: "app_store", product_mapping: { pro: "s" } } })).json() as any).id as string;
    const cfg = await customerCenterConfigOf(h.db, "proj1") as any;
    cfg.screens.MANAGEMENT.paths[0].promotional_offer = { retention_offer_id: id };
    expect((await post({ customer_center: cfg })).status).toBe(200);
    await h.fetch(`/v2/projects/proj1/retention_offers/${id}`, { method: "DELETE", key: h.ids.secretKey });
    // The Support page posts the stored overrides with only its fields changed.
    const overrides = await stored() as any;
    const res = await post({ customer_center: { ...overrides, support: { ...overrides.support, email: "tickets@scanner.app" } } });
    expect(res.status).toBe(200);
    expect((await customerCenterFor(h.db, "proj1") as any).screens.MANAGEMENT.paths[0].promotional_offer).toBeUndefined();
    cfg.screens.MANAGEMENT.paths[1].promotional_offer = { retention_offer_id: "ro_missing" };
    expect((await post({ customer_center: cfg })).status).toBe(400);
  });
});
