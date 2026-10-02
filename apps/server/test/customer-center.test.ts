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
    // A reference to an offer that does not exist is refused.
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
