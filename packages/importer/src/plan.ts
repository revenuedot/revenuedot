// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: `revenuedot import plan`, the cutover steps for one project with its real app ids and URLs.
// Docs: https://revenuedot.app/docs/migrate
import type { ImportStatus, RevenueDotClient } from "./revenuedot.js";
import { appIdentifier, credentialsConfigured, credentialsNeeded } from "./catalog.js";

export interface PlanStep { title: string; lines: string[] }

/** The cutover, in order. Every URL and id in it is the project's own. */
export async function buildPlan(rd: RevenueDotClient, o: { to: string; rcProject?: string | null; imported?: boolean }): Promise<PlanStep[]> {
  const project = await rd.project();
  const apps = await rd.apps();
  let status: ImportStatus | null = null;
  try { status = await rd.importStatus(); } catch { status = null; }
  const to = o.to.replace(/\/+$/, "");
  const apple = apps.filter((a) => a.type === "app_store" || a.type === "mac_app_store");
  const google = apps.filter((a) => a.type === "play_store");
  const importCmd = `npx revenuedot import --from-revenuecat --rc-key sk_... --rc-project ${o.rcProject ?? "<RevenueCat project id>"} --to ${to} --to-key <RevenueDot secret key>`;
  const steps: PlanStep[] = [];

  steps.push({
    title: "Import the catalog and customers",
    lines: [
      status && status.customers > 0 ? `Done: ${status.customers} customers and ${status.subscriptions} subscriptions are in RevenueDot project ${project.id}.` : `Run: ${importCmd}`,
      "Re-running the same command is safe: it updates what changed and creates nothing twice.",
    ],
  });

  const missing = apps.flatMap((a) => {
    const need = credentialsNeeded(a.type);
    return need && !credentialsConfigured(a) ? [`${a.name} (${a.type}${appIdentifier(a) ? `, ${appIdentifier(a)}` : ""}, app id ${a.id}): ${need}.`] : [];
  });
  steps.push({
    title: "Enter the store credentials in RevenueDot",
    lines: missing.length ? [`Open ${to}, go to Apps, and add:`, ...missing.map((m) => `- ${m}`)] : ["Every app already has its store credentials."],
  });

  if (status && status.needs_token_refresh > 0) {
    steps.push({
      title: "Run the import again to look up Google purchase tokens",
      lines: [
        `${status.needs_token_refresh} Google Play subscriptions have no purchase token yet. With the service account in place, run the import again: RevenueDot looks the tokens up by order id (orders.batchGet).`,
        "Any left over get their token from the next renewal notification, or when the updated app calls syncPurchases() once.",
      ],
    });
  }

  steps.push({
    title: "Run side by side: store notifications to RevenueDot, forwarded to RevenueCat",
    lines: [
      ...apple.flatMap((a) => [
        `App Store (${a.name}): in App Store Connect > App Information > App Store Server Notifications, set the Production and Sandbox URLs to ${to}/v1/notifications/apple/${a.id}`,
        `  Then forward to RevenueCat, so it keeps working for app versions that still call it (copy the Apple notification URL from RevenueCat's app settings):`,
        `  curl -X POST ${to}/v2/projects/${project.id}/apps/${a.id} -H "Authorization: Bearer <RevenueDot secret key>" -H "content-type: application/json" -d '{"app_store":{"notification_forward_url":"<RevenueCat Apple notification URL>"}}'`,
      ]),
      ...google.flatMap((a) => [
        `Google Play (${a.name}): in Google Cloud > Pub/Sub, open the topic set in Play Console > Monetization setup and add a push subscription to ${to}/v1/notifications/google/${a.id}`,
        "  RevenueCat's own subscription on the same topic keeps receiving every notification, so nothing needs forwarding.",
      ]),
      ...(apple.length || google.length ? [] : ["No App Store or Google Play apps in this project."]),
      "Do not add webhooks in RevenueDot yet: RevenueCat still sends yours, and both would fire for the same purchase.",
    ],
  });

  steps.push({
    title: "Ship an app update that talks to RevenueDot",
    lines: [
      `Set the proxy URL before configuring the SDK. The API keys stay the same (the import kept them).`,
      `- iOS (Swift): Purchases.proxyURL = URL(string: "${to}")!`,
      `- Android (Kotlin): Purchases.proxyURL = URL("${to}")`,
      `- React Native: await Purchases.setProxyURL("${to}")`,
      `- Flutter: await Purchases.setProxyURL("${to}");`,
      `- Web (purchases-js): Purchases.configure({ apiKey, appUserId, httpConfig: { proxyURL: "${to}" }, flags: { collectAnalyticsEvents: false } })`,
      `- Capacitor: await Purchases.setProxyURL({ url: "${to}" });`,
      `- Kotlin Multiplatform: Purchases.proxyURL = "${to}"`,
      `- Unity: on the Purchases component, set Proxy URL (under Advanced) to ${to}`,
      `- Cordova: Purchases.setProxyURL("${to}");`,
      "Do not turn on enforced entitlement verification with the stock SDKs: RevenueDot cannot sign with RevenueCat's key, so checks report FAILED (informational mode, the iOS and Android default, still grants access). Our SDK forks carry RevenueDot's key and verify normally.",
      "On Android, call Purchases.sharedInstance.syncPurchases() once after the update, so any missing Google purchase token arrives.",
    ],
  });

  steps.push({
    title: "Keep RevenueDot current while old app versions still call RevenueCat",
    lines: [
      `Re-run the import daily until old versions fade out: ${importCmd}`,
      `Check the result: npx revenuedot import verify --rc-key sk_... --rc-project ${o.rcProject ?? "<RevenueCat project id>"} --to ${to} --to-key <RevenueDot secret key>`,
    ],
  });

  steps.push({
    title: "Finish the cutover",
    lines: [
      "When verify shows no differences and old app versions are negligible:",
      ...apple.map((a) => `- Remove the forwarding URL of ${a.name} (set notification_forward_url to null).`),
      "- Create your webhooks in RevenueDot, then turn off the webhooks in RevenueCat.",
      "- Switch dashboards, alerts and internal tools to RevenueDot's REST API (same v2 shapes).",
    ],
  });
  return steps;
}

export function formatPlan(steps: PlanStep[]): string {
  return steps.map((s, i) => [`${i + 1}. ${s.title}`, ...s.lines.map((l) => `   ${l}`)].join("\n")).join("\n\n");
}
