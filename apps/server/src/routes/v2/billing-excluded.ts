import type { Deps } from "../../context.js";
import { findCustomer } from "../../repo/customers.js";
import { V2Error, listOf, notFound, scope, type V2Router } from "./common.js";

/**
 * Invoices (2 operations) exist only for RevenueCat Billing, which issues its own invoices; RevenueDot's web checkout runs on
 * the developer's Stripe, where Stripe issues them. They are routed so a client never meets an unknown-route 404, and every
 * answer is valid for the operation in RevenueCat's spec: the list is empty, and a single file is a 404 with the reason.
 * Discounts are real since web billing (discounts.ts, prd/web-billing/PRD.md §6).
 */
const INVOICES = "Invoices are issued by RevenueCat Billing. For web purchases through RevenueDot, Stripe issues the invoices in your Stripe account.";

export function billingExcludedRoutes(r: V2Router, deps: Deps) {
  const C = "/v2/projects/:project_id/customers/:customer_id/invoices";
  const invoices = scope("customer_information:invoices:read");
  r.get(C, invoices, async (c) => {
    const cust = await findCustomer(deps.db, c.get("projectId"), c.req.param("customer_id")!);
    if (!cust) throw notFound("Customer");
    return c.json(listOf(c, [], null));
  });
  r.get(`${C}/:invoice_id/file`, invoices, () => { throw new V2Error(404, "resource_missing", `Invoice not found. ${INVOICES}`, "invoice_id"); });
}
