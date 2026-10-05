// Pictures for the onboarding emails that are renders of our own emails (prd/onboarding-emails/PRD.md): today the payment
// recovery email a developer's customer receives, framed as an inbox message. 1200×675 JPEG in apps/site/public/email/art/.
//   pnpm tsx scripts/email-art.ts
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recoveryEmail } from "../apps/server/src/mail/templates.js";
import { DEFAULT_STEPS } from "../apps/server/src/services/payment-recovery.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "../apps/site/public/email/art");
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(path.join(here, "../apps/dashboard/package.json"))("@playwright/test");

const app = "Habitly";
const fill = (s: string) => s.replace(/\{app\}/g, app);
const step = DEFAULT_STEPS[0]!;
const mail = recoveryEmail({ appName: app, subject: fill(step.subject), heading: fill(step.heading), body: fill(step.body), buttonLabel: fill(step.button_label), linkUrl: "https://pay.example.com", unsubscribeUrl: "https://example.com/u" });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 675 }, deviceScaleFactor: 1 });
// An inbox message: sender and subject on top, the email itself below, on a light ground.
await page.setContent(`<!doctype html><html><head><style>
  *{margin:0;box-sizing:border-box}body{width:1200px;height:675px;overflow:hidden;background:#F2F2F2;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  .win{position:absolute;left:150px;top:44px;width:900px;background:#fff;border:1px solid #DADADA;box-shadow:0 24px 60px rgba(0,0,0,.10)}
  .hd{padding:22px 28px 18px;border-bottom:1px solid #E5E5E5;display:flex;gap:14px;align-items:center}
  .av{width:40px;height:40px;border-radius:50%;background:#2F6F9F;color:#fff;font:700 17px/40px sans-serif;text-align:center}
  .from b{font-size:15px;color:#0A0A0A}.from span{font-size:13px;color:#737373;margin-left:6px}.subj{font-size:19px;font-weight:600;color:#0A0A0A;margin-top:3px}
  iframe{display:block;width:900px;height:560px;border:0}
</style></head><body><div class="win"><div class="hd"><div class="av">H</div><div><div class="from"><b>${app}</b><span>to you</span></div><div class="subj">${mail.subject.replace(/</g, "&lt;")}</div></div></div>
<iframe srcdoc="${mail.html.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe></div></body></html>`, { waitUntil: "load" });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, "recovery-email.jpg"), type: "jpeg", quality: 84 });
await browser.close();
console.log("wrote", path.join(out, "recovery-email.jpg"));
