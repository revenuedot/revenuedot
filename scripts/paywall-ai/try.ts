// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// Dev: runs the AI paywall designer (packages/core/src/paywalls/designer) once with the server's model choice
// (services/paywall-ai.ts: AI_GATEWAY_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY from the environment) and prints the
// steps, timings and the checker's output. Load keys by name, e.g. `set -a; source ~/.config/revenuedot/prod.env; set +a`.
//   pnpm tsx scripts/paywall-ai/try.ts "A calm sleep app called Drift …" [out.json]
import { writeFileSync } from "node:fs";
import { runDesigner } from "../../packages/core/src/index.ts";
import { paywallModelFromEnv } from "../../apps/server/src/services/paywall-ai.ts";

const prompt = process.argv[2] || "A calm sleep and meditation app called Drift. Lead with a 7-day free trial on the yearly plan, show the monthly plan as the alternative, list 3 benefits (sleep stories, guided breathing, offline downloads), dark night-sky look.";
const model = paywallModelFromEnv(process.env);
if (!model) throw new Error("Set AI_GATEWAY_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY.");
console.log(`model: ${model.provider} · ${model.model}`);
const t0 = Date.now();
const r = await runDesigner({ prompt, offering: { offering: { id: "ofrng1", lookup_key: "default", display_name: "Default" }, packages: [
  { id: "$rc_annual", label: "Yearly", product: { store_identifier: "drift.yearly", name: "Drift Yearly", type: "subscription", duration: "P1Y", price: { amount: 59.99, currency: "USD" } } },
  { id: "$rc_monthly", label: "Monthly", product: { store_identifier: "drift.monthly", name: "Drift Monthly", type: "subscription", duration: "P1M", price: { amount: 9.99, currency: "USD" } } },
] } }, model, { iconBaseUrl: "https://api.revenuedot.app/assets/icons", onStep: (e) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, e.id, e.status, e.detail ?? "") });
console.log(JSON.stringify({ brief: r.brief, rounds: r.rounds, firstDraftErrors: r.firstDraftErrors, warnings: r.warnings, fixes: r.fixes, notes: r.notes, calls: r.calls, usage: r.usage }, null, 2));
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(r, null, 2));
