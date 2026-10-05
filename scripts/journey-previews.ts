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

/** Two people the emails are written for: Sam builds a new app and has never used RevenueCat; Maya switches from it. */
const sam = (step: StepId): JourneyCtx => ({
  step, app, first: "Sam", projectId: "proj_n0tely", projectName: "Notely", to: "sam@notely.app",
  unsubscribeUrl: `${app}/auth/journeys/unsubscribe/${token}`,
  pathUrl: (p) => `${app}/auth/journeys/path/${token}?path=${p}`,
  verifyUrl: `${app}/verify-email?token=${token}`,
  testPurchase: true, sdk: { platform: "React Native", version: "10.10.2" }, migrating: false,
  sale: { product: "notely_pro_monthly", amount: "$4.99", country: "Canada" },
  tracked: 13_870, month: "October", overTracked: 13_870, overMonth: "September",
  inviter: "Sam Rivera",
});
const maya = (step: StepId): JourneyCtx => ({
  ...sam(step), first: "Maya", projectId: "proj_hab1t5", projectName: "Habitly", to: "maya@habitly.app", migrating: true,
  sdk: { platform: "Flutter", version: "9.6.1" }, importedCustomers: 18_420, importedOn: "September 24",
  sale: { product: "habitly_pro_annual", amount: "$39.99", country: "Germany" },
  last7: 11_270, projected: Math.round((11_270 * 30) / 7), tracked: 48_300,
});
const withBills = (c: JourneyCtx): JourneyCtx => {
  const basis = c.step === "cutover" ? c.projected! : c.tracked!;
  return { ...c, bills: { revenuedot: rd(basis), revenuecat: rc(basis) } };
};

/** Every email in the order a reader meets it, with each variant: [file name, who it goes to]. */
const at = (c: JourneyCtx, testPurchase: boolean, app: boolean, store: boolean): JourneyCtx => ({ ...c, testPurchase, progress: { testPurchase, app, store, live: false } });
const VARIANTS: [string, JourneyCtx][] = [
  ["welcome", sam("welcome")],
  ["verify_reminder", sam("verify_reminder")],
  ["connect_app", at(sam("connect_app"), true, false, false)],
  ["store_keys", at(sam("store_keys"), true, true, false)],
  ["paywall", at(sam("paywall"), true, true, true)],
  ["need_hand-start", at(sam("need_hand"), false, false, false)],
  ["need_hand-connect", at(sam("need_hand"), true, false, false)],
  ["need_hand-store", at(sam("need_hand"), true, true, false)],
  ["first_sale", { ...sam("first_sale"), progress: { testPurchase: true, app: true, store: true, live: true } }],
  ["first_sale-existing", { ...sam("first_sale"), projectName: "Pocket Yoga", sale: { product: "yoga_annual", amount: "$59.99", country: "United States", renewal: true }, progress: { testPurchase: false, app: false, store: true, live: true } }],
  ["standard_welcome", sam("standard_welcome")],
  ["teammate_welcome", { ...sam("teammate_welcome"), first: "Jordan", to: "jordan@notely.app" }],
  ["need_hand-switch", { ...maya("need_hand"), importedOn: undefined }],
  ["side_by_side", maya("side_by_side")],
  ["need_hand-forwarding", maya("need_hand")],
  ["first_sale-switch", { ...maya("first_sale"), progress: { testPurchase: false, app: false, store: true, live: true } }],
  ["first_sale-switch-app", { ...maya("first_sale"), progress: { testPurchase: false, app: true, store: true, live: true } }],
  ["cutover", maya("cutover")],
];

const index: { name: string; step: StepId; subject: string; preheader: string; bytes: number }[] = [];
for (const [name, ctx] of VARIANTS) {
  if (only.length && !only.includes(ctx.step)) continue;
  const m = journeyEmail(withBills(ctx));
  writeFileSync(join(out, `${name}.html`), m.html);
  writeFileSync(join(out, `${name}.txt`), `Subject: ${m.subject}\n\n${m.text}`);
  const pre = /<div style="display:none[^>]*>([^<&]*)/.exec(m.html)?.[1] ?? "";
  index.push({ name, step: ctx.step, subject: m.subject, preheader: pre, bytes: Buffer.byteLength(m.html) });
}
const missing = STEP_IDS.filter((st) => !VARIANTS.some(([, c]) => c.step === st));
if (missing.length) throw new Error(`No preview for: ${missing.join(", ")}`);
writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2));
console.log(index.map((x) => `${x.name.padEnd(22)} ${String(x.bytes).padStart(6)}  ${x.subject}`).join("\n"));
