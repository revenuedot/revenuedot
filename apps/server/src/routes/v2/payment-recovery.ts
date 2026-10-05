import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { isEmailAddress, oneClickUnsubscribeHeaders, trySend } from "../../mail/index.js";
import { TEST_EMAIL_TOKEN } from "../../services/winback.js";
import { hit } from "../../services/rate-limit.js";
import { DEFAULT_STEPS, listCases, projectSettings, recoveryStats, renderStep, runPaymentRecovery, type RecoverySettings } from "../../services/payment-recovery.js";
import { publicOrigin } from "../oauth.js";
import { V2Error, body, listOf, paramError, scope, type V2Context, type V2Router } from "./common.js";

/**
 * Payment recovery (RevenueDot extension; prd/payment-recovery/PRD.md):
 *   GET, POST /v2/projects/{id}/payment_recovery                 settings
 *   GET       /v2/projects/{id}/payment_recovery/stats           at risk, messages, recovered (attributed), lost, rate
 *   GET       /v2/projects/{id}/payment_recovery/cases           cases, newest first
 *   POST      /v2/projects/{id}/payment_recovery/actions/send_test
 *   POST      /v2/projects/{id}/payment_recovery/actions/run
 */

const StepIn = z.object({
  day: z.number().int().min(0).max(60),
  subject: z.string().trim().min(1).max(150), heading: z.string().trim().min(1).max(150), body: z.string().trim().min(1).max(4000), button_label: z.string().trim().min(1).max(40),
}).strict();
const SettingsIn = z.object({
  enabled: z.boolean(),
  steps: z.array(StepIn).min(1).max(5)
    .refine((s) => s.every((x, i) => i === 0 || x.day > s[i - 1]!.day), { message: "steps must be in order of day, each on a later day than the one before" }),
  window_days: z.number().int().min(7).max(60).default(30),
  include_sandbox: z.boolean().default(false),
  sender_name: z.string().trim().max(80).nullable().optional(),
}).strict().refine((s) => !s.steps.length || s.steps[s.steps.length - 1]!.day < s.window_days, { message: "the last step must come before the recovery window ends", path: ["window_days"] });

export function paymentRecoveryRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/payment_recovery";
  const shape = (s: RecoverySettings) => ({
    object: "payment_recovery_settings" as const, enabled: s.enabled, steps: s.steps, window_days: s.window_days, include_sandbox: s.include_sandbox,
    sender_name: s.sender_name, default_steps: DEFAULT_STEPS,
  });
  const sandboxOf = (c: V2Context) => {
    const e = c.req.query("environment") ?? "production";
    if (e !== "production" && e !== "sandbox") throw paramError("environment must be production or sandbox.", "environment");
    return e === "sandbox";
  };

  r.get(P, scope("project_configuration:projects:read"), async (c) => c.json(shape((await projectSettings(db, c.get("projectId"))).settings)));

  r.post(P, scope("project_configuration:projects:read_write"), async (c) => {
    const b = await body(c, SettingsIn);
    const stored = { ...b, sender_name: b.sender_name || null, link_base: deps.publicUrl ?? publicOrigin(c) };
    await db.update(schema.projects).set({ recoverySettings: stored as unknown as Record<string, unknown> }).where(eq(schema.projects.id, c.get("projectId")));
    // Open cases follow the new schedule: the next step of each is due on its new day.
    const steps = b.steps.map((s) => s.day);
    await db.execute(sqlSchedule(c.get("projectId"), steps));
    return c.json(shape((await projectSettings(db, c.get("projectId"))).settings));
  });

  r.get(`${P}/stats`, scope("customer_information:customers:read"), async (c) => {
    const days = Number(c.req.query("days") ?? 28);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw paramError("days must be a whole number from 1 to 365.", "days");
    return c.json(await recoveryStats(db, c.get("projectId"), { days, sandbox: sandboxOf(c), now: deps.now() }));
  });

  r.get(`${P}/cases`, scope("customer_information:customers:read"), async (c) => {
    const status = c.req.query("status") || undefined;
    if (status && !["open", "recovered", "lost"].includes(status)) throw paramError("status must be open, recovered or lost.", "status");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20) || 20, 1), 100);
    const { items, next } = await listCases(db, c.get("projectId"), { status: status as "open" | undefined, sandbox: sandboxOf(c), limit, startingAfter: c.req.query("starting_after") || null });
    return c.json(listOf(c, items, next));
  });

  r.post(`${P}/actions/send_test`, scope("project_configuration:projects:read_write"), async (c) => {
    const projectId = c.get("projectId");
    // `content` and `sender_name` preview unsaved edits; otherwise the saved step is sent.
    const b = await body(c, z.object({ email: z.string().refine(isEmailAddress, "a single email address"), step: z.number().int().min(0).max(4).default(0), content: StepIn.optional(), sender_name: z.string().trim().max(80).nullable().optional() }).strict());
    if (!(await hit(db, `recovery-test:${projectId}`, 10, 3600_000, deps.now()))) throw new V2Error(429, "rate_limit_error", "Too many test emails. Try again in an hour.", undefined, true);
    const { settings, projectName } = await projectSettings(db, projectId);
    const step = b.content ?? settings.steps[b.step];
    if (!step) throw paramError(`There is no step ${b.step + 1}.`, "step");
    const base = deps.publicUrl ?? publicOrigin(c);
    const appName = (b.sender_name === undefined ? settings.sender_name : b.sender_name || null) ?? projectName;
    const mail = renderStep(step, appName, base, TEST_EMAIL_TOKEN);
    const ok = await trySend(deps.mailer, { to: b.email, ...mail, subject: `[Test] ${mail.subject}`, fromName: appName, headers: oneClickUnsubscribeHeaders(`${base}/v1/recovery/u/${TEST_EMAIL_TOKEN}`) });
    if (!ok) throw new V2Error(502, "server_error", "The mailer did not accept the test email. Check the server's mail settings.", undefined, true);
    return c.json({ object: "payment_recovery_test", sent_to: b.email, step: b.step });
  });

  r.post(`${P}/actions/run`, scope("project_configuration:projects:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const { settings } = await projectSettings(db, projectId);
    if (!settings.enabled) throw new V2Error(422, "unprocessable_entity_error", "Turn payment recovery on before sending.");
    const out = await runPaymentRecovery({
      db, mailer: deps.mailer, now: deps.now, publicUrl: deps.publicUrl ?? publicOrigin(c), stores: deps.stores, fetch: deps.fetch,
      encryptionKey: deps.encryptionKey, signingKey: deps.signingKey, stripeConnect: deps.stripeConnect,
    }, { onlyProject: projectId, limit: 500 });
    return c.json({ object: "payment_recovery_run", ...out });
  });
}

/** Moves each open case's next step to its day under the new schedule (or none when every step is sent). */
function sqlSchedule(projectId: string, days: number[]) {
  // steps_sent is how many steps went out; the next is days[steps_sent].
  return sql`UPDATE recovery_cases SET next_step_at = CASE
      ${sql.join(days.map((d, i) => sql`WHEN steps_sent = ${i} THEN detected_at + make_interval(days => ${d})`), sql` `)}
      ELSE NULL END
    WHERE project_id = ${projectId} AND status = 'open' AND (skip_reason IS NULL OR skip_reason NOT IN ('unsubscribed', 'issue_cleared'))`;
}
