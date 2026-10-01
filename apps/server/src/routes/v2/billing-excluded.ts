import type { Deps } from "../../context.js";
import { findCustomer } from "../../repo/customers.js";
import { V2Error, listOf, notFound, scope, type V2Router } from "./common.js";

/**
 * Discounts (10 operations) and invoices (2) exist only for RevenueCat Billing, the billing engine RevenueCat runs for web
 * checkout, which RevenueDot does not have; the scope rule leaves them out (prd/rest-api/PRD.md). They are routed so a client
 * never meets an unknown-route 404, and every answer is valid for the operation in RevenueCat's spec:
 * writes answer 422, lists are empty, and reads of one object answer 404 with the reason.
 */
const WHY = "Discounts are part of RevenueCat Billing (Web Billing), which RevenueDot does not have.";
const INVOICES = "Invoices are issued by RevenueCat Billing (Web Billing), which RevenueDot does not have.";
const unavailable = () => { throw new V2Error(422, "unprocessable_entity_error", WHY); };

export function billingExcludedRoutes(r: V2Router, deps: Deps) {
  const D = "/v2/projects/:project_id/discounts";
  const read = scope("project_configuration:discounts:read");
  const write = scope("project_configuration:discounts:read_write");

  r.get(D, read, (c) => c.json(listOf(c, [], null)));
  r.post(D, write, unavailable);
  r.get(`${D}/:discount_id`, read, () => { throw new V2Error(404, "resource_missing", `Discount not found. ${WHY}`, "discount_id"); });
  r.patch(`${D}/:discount_id`, write, unavailable);
  r.delete(`${D}/:discount_id`, write, unavailable);
  r.post(`${D}/:discount_id/actions/enable`, write, unavailable);
  r.post(`${D}/:discount_id/actions/disable`, write, unavailable);
  r.get(`${D}/:discount_id/discount_codes`, read, () => { throw new V2Error(404, "resource_missing", `Discount not found. ${WHY}`, "discount_id"); });
  r.post(`${D}/:discount_id/discount_codes`, write, unavailable);
  r.delete(`${D}/:discount_id/discount_codes/:discount_code`, write, unavailable);

  const C = "/v2/projects/:project_id/customers/:customer_id/invoices";
  const invoices = scope("customer_information:invoices:read");
  r.get(C, invoices, async (c) => {
    const cust = await findCustomer(deps.db, c.get("projectId"), c.req.param("customer_id")!);
    if (!cust) throw notFound("Customer");
    return c.json(listOf(c, [], null));
  });
  r.get(`${C}/:invoice_id/file`, invoices, () => { throw new V2Error(404, "resource_missing", `Invoice not found. ${INVOICES}`, "invoice_id"); });
}
