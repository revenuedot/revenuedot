import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { desc, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { SESSION_COOKIE, sessionUser } from "../services/sessions.js";
import { linkBase, requestOrigin } from "../services/account-email.js";
import { accountOf, accountUsage } from "../services/billing/meter.js";
import { billCents, monthBounds, monthOf, planOf, plansFrom } from "../services/billing/plans.js";
import { BillingStripeError, billingStripe, stripeProblem } from "../services/billing/stripe.js";
import { handleBillingEvent } from "../services/billing/webhook.js";
import { StripeSignatureError, verifyStripeSignature } from "../stores/stripe/signature.js";

/**
 * RevenueDot Cloud billing (prd/cloud-billing/PRD.md): the Billing page's data, Stripe Checkout and Customer Portal, and
 * the webhook of RevenueDot's own Stripe account. Session auth (an account, not a project). Self-host answers 404:
 * self-hosting is free and unmetered.
 */
export function billingRoutes(deps: Deps) {
  const r = new Hono();
  const { db } = deps;
  const err = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 502 | 503, type: string, message: string) => c.json({ object: "error", type, message }, status);
  const cloud = () => deps.edition === "cloud";
  const plans = () => plansFrom(deps.billing?.plansJson);
  const base = (c: Context) => linkBase(deps, requestOrigin(c.req.url, (n) => c.req.header(n)));

  r.use("/v2/billing/*", async (c, next) => { if (!cloud()) return err(c, 404, "resource_missing", "Billing is only on RevenueDot Cloud. Self-hosting is free and unmetered."); await next(); });
  r.use("/v2/billing", async (c, next) => { if (!cloud()) return err(c, 404, "resource_missing", "Billing is only on RevenueDot Cloud. Self-hosting is free and unmetered."); await next(); });

  const user = async (c: Context) => sessionUser(db, getCookie(c, SESSION_COOKIE), deps.now());

  r.get("/v2/billing", async (c) => {
    const u = await user(c);
    if (!u) return err(c, 401, "authentication_error", "Sign in to see billing.");
    const now = deps.now();
    const month = monthOf(now);
    const acct = await accountOf(db, u.id);
    const all = plans();
    const plan = planOf(all, acct?.plan ?? "free");
    const usage = await accountUsage(db, u.id, month);
    const standard = planOf(all, "standard");
    const invoices = await db.select().from(schema.billingInvoices).where(eq(schema.billingInvoices.userId, u.id)).orderBy(desc(schema.billingInvoices.createdAt)).limit(24);
    const owned = await db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.ownerUserId, u.id));
    const { end } = monthBounds(month);
    const flags: string[] = [];
    if (acct?.status === "past_due") flags.push("past_due");
    if (acct?.status === "unpaid") flags.push("unpaid");
    if (plan.id === "free" && plan.limit_usd !== null && usage.tracked_revenue_usd > plan.limit_usd) flags.push("over_free_limit");
    if (plan.id === "standard" && plan.limit_usd !== null && usage.tracked_revenue_usd > plan.limit_usd) flags.push("over_standard_limit");
    return c.json({
      object: "billing", edition: "cloud",
      account: { plan: plan.id, status: acct?.status ?? "none", cancel_at: acct?.cancelAt?.getTime() ?? null, current_period_end: acct?.currentPeriodEnd?.getTime() ?? null, has_payment_method: !!acct?.stripeCustomerId },
      plans: all,
      usage: {
        ...usage,
        // Owned projects with no revenue yet still show, at $0.
        projects: [...usage.projects, ...owned.filter((p) => !usage.projects.some((x) => x.project_id === p.id)).map((p) => ({ project_id: p.id, name: p.name, tracked_revenue_usd: 0, transactions: 0 }))],
        bill_usd: billCents(plan, usage.tracked_revenue_usd) / 100,
        standard_bill_usd: billCents(standard, usage.tracked_revenue_usd) / 100,
        free_limit_usd: planOf(all, "free").limit_usd, cap_usd: standard.cap_usd, ceiling_usd: standard.limit_usd, period_end: end.getTime(),
      },
      flags,
      invoices: invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, amount_due: i.amountDue / 100, amount_paid: i.amountPaid / 100, currency: i.currency, period_start: i.periodStart?.getTime() ?? null, period_end: i.periodEnd?.getTime() ?? null, hosted_invoice_url: i.hostedInvoiceUrl, invoice_pdf: i.invoicePdf, created_at: i.createdAt.getTime() })),
      stripe_ready: !stripeProblem(deps.billing), stripe_problem: stripeProblem(deps.billing),
    });
  });

  const writeGuard = (c: Context) => {
    const site = c.req.header("sec-fetch-site");
    return site === "cross-site" || site === "same-site";
  };

  r.post("/v2/billing/checkout", async (c) => {
    const u = await user(c);
    if (!u) return err(c, 401, "authentication_error", "Sign in first.");
    if (writeGuard(c)) return err(c, 403, "authorization_error", "Dashboard requests must come from the dashboard.");
    const b = await c.req.json().catch(() => ({})) as { plan?: string };
    if (b.plan !== "standard") return err(c, 400, "parameter_error", "Only Cloud Standard has a self-serve checkout. For Enterprise, write to hello@revenuedot.app.");
    const problem = stripeProblem(deps.billing);
    if (problem) return err(c, 503, "server_error", problem);
    const acct = await accountOf(db, u.id);
    if (acct?.plan === "standard" && ["active", "past_due"].includes(acct.status)) return err(c, 409, "resource_already_exists", "You are on Cloud Standard already. Manage it with Manage billing.");
    try {
      const stripe = billingStripe(deps.billing!, deps.fetch);
      let customer = acct?.stripeCustomerId ?? null;
      if (!customer) {
        customer = (await stripe.createCustomer({ email: u.email, name: u.name, userId: u.id })).id;
        const set = { stripeCustomerId: customer, updatedAt: deps.now() };
        await db.insert(schema.billingAccounts).values({ userId: u.id, ...set, createdAt: deps.now() }).onConflictDoUpdate({ target: schema.billingAccounts.userId, set });
      }
      const now = deps.now();
      const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const s = await stripe.createCheckout({ customer, userId: u.id, anchor, successUrl: `${base(c)}/account/billing?checkout=success`, cancelUrl: `${base(c)}/account/billing?checkout=cancelled` });
      return c.json({ object: "checkout", url: s.url, id: s.id });
    } catch (e) {
      return err(c, 502, "server_error", e instanceof BillingStripeError ? e.message : "Stripe could not start the checkout.");
    }
  });

  r.post("/v2/billing/portal", async (c) => {
    const u = await user(c);
    if (!u) return err(c, 401, "authentication_error", "Sign in first.");
    if (writeGuard(c)) return err(c, 403, "authorization_error", "Dashboard requests must come from the dashboard.");
    const problem = stripeProblem(deps.billing);
    if (problem) return err(c, 503, "server_error", problem);
    const acct = await accountOf(db, u.id);
    if (!acct?.stripeCustomerId) return err(c, 409, "resource_missing", "There is no payment method yet. Upgrade first.");
    try {
      const s = await billingStripe(deps.billing!, deps.fetch).createPortal({ customer: acct.stripeCustomerId, returnUrl: `${base(c)}/account/billing` });
      return c.json({ object: "portal", url: s.url });
    } catch (e) {
      return err(c, 502, "server_error", e instanceof BillingStripeError ? e.message : "Stripe could not open the billing portal.");
    }
  });

  r.post("/v2/billing/stripe/webhook", async (c) => {
    const secret = deps.billing?.webhookSecret;
    if (!secret) return err(c, 503, "server_error", "Billing webhooks are not set up on this server.");
    const raw = await c.req.text();
    try { await verifyStripeSignature(raw, c.req.header("stripe-signature"), secret, deps.now()); } catch (e) {
      return err(c, 400, "authentication_error", e instanceof StripeSignatureError ? e.message : "Bad signature.");
    }
    let event: { id: string; type: string; data: { object: Record<string, unknown> } };
    try { event = JSON.parse(raw); } catch { return err(c, 400, "invalid_request", "The body is not JSON."); }
    const result = await handleBillingEvent({ db, now: deps.now(), mailer: deps.mailer, publicUrl: deps.publicUrl }, event);
    return c.json({ received: true, result });
  });

  return r;
}
