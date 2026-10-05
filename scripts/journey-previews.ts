// Renders every onboarding and growth email (prd/onboarding-emails/PRD.md) with realistic sample data, for review and
// test sends. Writes <step>.html, <step>.txt and index.json (subject, preheader per step) into the folder given.
//   [ALL_VIDEOS=1] pnpm tsx scripts/journey-previews.ts /tmp/journeys [step ...]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { journeyEmail, STEP_IDS, VIDEOS, type JourneyCtx, type StepId } from "../apps/server/src/mail/journeys.js";
import { billCents, DEFAULT_PLANS, planOf } from "../apps/server/src/services/billing/plans.js";

const out = process.argv[2] ?? "journey-previews";
// ALL_VIDEOS=1 shows every video cover, as the emails will look once each video is published.
if (process.env.ALL_VIDEOS === "1") for (const v of Object.values(VIDEOS)) v.ready = true;
const only = process.argv.slice(3) as StepId[];
mkdirSync(out, { recursive: true });

const std = planOf(DEFAULT_PLANS, "standard");
const rd = (r: number) => billCents(std, r) / 100;
const rc = (r: number) => (r >= 2_500 ? r / 100 : 0);
const app = "https://app.revenuedot.app";
const token = "preview-token-0123456789abcdef";

/** The account each email is shown for: a Flutter habit app founder, the persona most of these emails speak to. */
const base = (step: StepId): JourneyCtx => ({
  step, app, first: "Maya", projectId: "proj_hab1t5", projectName: "Habitly",
  unsubscribeUrl: `${app}/auth/journeys/unsubscribe/${token}`,
  pathUrl: (p) => `${app}/auth/journeys/path/${token}?path=${p}`,
  verifyUrl: `${app}/verify-email?token=${token}`,
  testPurchase: true, sdk: { platform: "Flutter", version: "9.6.1" }, importedCustomers: 18_420,
  sale: { product: "habitly_pro_annual", amount: "$39.99", country: "Germany" },
  tracked: step === "enterprise" ? 612_400 : step === "pricing_explainer" ? 6_240 : step === "cutover" ? 48_300 : 13_870,
  month: "October",
  priceRows: [10_000, 20_000, 50_000, 100_000, 250_000, 500_000].map((r) => [r, rd(r), rc(r)]),
  lastSaleAt: new Date("2026-09-26T12:00:00Z"),
  referralUrl: `${app}/signup?ref=k7m2q9xa`,
  inviter: "Maya Chen",
});
const ctxFor = (step: StepId): JourneyCtx => {
  const c = base(step);
  c.bills = { revenuedot: rd(c.tracked!), revenuecat: rc(c.tracked!) };
  if (step === "teammate_welcome") c.first = "Jordan";
  c.projected = Math.round(c.tracked! / 4 * 31);
  c.liveSince = "September 2";
  if (["checkin", "need_hand", "import_help", "forwarding_check", "side_by_side", "switch_plan", "cutover"].includes(step)) c.migrating = true;
  if (step === "cutover") c.bills = { revenuedot: rd(c.projected), revenuecat: rc(c.projected) };
  return c;
};

const index: { step: StepId; subject: string; preheader: string; bytes: number }[] = [];
for (const step of only.length ? only : STEP_IDS) {
  const m = journeyEmail(ctxFor(step));
  writeFileSync(join(out, `${step}.html`), m.html);
  writeFileSync(join(out, `${step}.txt`), `Subject: ${m.subject}\n\n${m.text}`);
  const pre = /<div style="display:none[^>]*>([^<&]*)/.exec(m.html)?.[1] ?? "";
  index.push({ step, subject: m.subject, preheader: pre, bytes: Buffer.byteLength(m.html) });
}
writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2));
console.log(index.map((x) => `${x.step.padEnd(18)} ${String(x.bytes).padStart(6)}  ${x.subject}`).join("\n"));
