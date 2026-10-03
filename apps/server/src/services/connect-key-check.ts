import type { Deps } from "../context.js";
import type { AppRow } from "../stores/types.js";
import { appleHttpFor } from "../stores/apple/index.js";
import { AppStoreConnectApi, ConnectError, connectCredentials, type Resource } from "../stores/apple/connect.js";

/**
 * The live check of an app's App Store Connect API key (prd/apps-setup/PRD.md "App Store Connect API key check"): a JWT
 * signed with the .p8, then `GET /v1/apps` filtered by the app's bundle ID, then one page of the app's subscription groups
 * and in-app purchases (what Import products and the product editor read). Nothing is written to App Store Connect.
 * Apple answers 401 for every authentication failure (wrong key ID, wrong issuer ID, a .p8 of another key, a revoked
 * key), so the formats are checked first and the 401 message names each of them.
 */

export interface ConnectKeyCheck { status: "valid" | "invalid" | "unreachable"; message: string; extra: Record<string, unknown> }

const KEY_ID = /^[A-Z0-9]{10}$/;
const ISSUER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE = "App Manager or Admin";

export async function checkConnectKey(deps: Pick<Deps, "stores" | "fetch" | "now">, app: Pick<AppRow, "bundleId" | "credentials">): Promise<ConnectKeyCheck> {
  const invalid = (message: string, extra: Record<string, unknown> = {}): ConnectKeyCheck => ({ status: "invalid", message, extra });
  const creds = connectCredentials(app);
  if (!creds) {
    const c = app.credentials ?? {};
    const missing = [["the .p8 file", "app_store_connect_api_key"], ["the key ID", "app_store_connect_api_key_id"], ["the issuer ID", "app_store_connect_api_key_issuer"]]
      .filter(([, k]) => !(typeof c[k!] === "string" && (c[k!] as string).trim())).map(([n]) => n);
    return invalid(`The App Store Connect API key is incomplete: add ${missing.join(", ").replace(/, ([^,]*)$/, " and $1")}.`);
  }
  const extra = { key_id: creds.keyId };
  if (!KEY_ID.test(creds.keyId)) return invalid(`The key ID "${creds.keyId}" is not an App Store Connect key ID: those are 10 capital letters and digits, such as 2X9R4HXF34. It is in the file name AuthKey_<key ID>.p8 and in the Key ID column under Users and Access → Integrations → App Store Connect API.`, extra);
  if (!ISSUER_ID.test(creds.issuerId)) return invalid(`The issuer ID "${creds.issuerId}" is not an App Store Connect issuer ID: that is a UUID such as 69a6de70-79a7-47e3-e053-5b8c7c11a4d1, shown above the keys list under Users and Access → Integrations → App Store Connect API.`, extra);
  if (!app.bundleId) return invalid("The app has no bundle ID. Add it in App details above, then check the key again.", extra);

  const { fetchFn, now } = appleHttpFor(deps.stores, deps.fetch, deps.now);
  const api = new AppStoreConnectApi(creds, fetchFn, now);
  let step: "apps" | "products" = "apps";
  try {
    const found = await api.appByBundleId(app.bundleId);
    if (!found) {
      // The key works (Apple answered 200), so the app is in another team or the bundle ID differs.
      const any = await api.send<{ data?: Resource[]; meta?: { paging?: { total?: number } } }>("GET", "/v1/apps?limit=1&fields[apps]=bundleId");
      const total = any.meta?.paging?.total ?? any.data?.length ?? 0;
      return invalid(total
        ? `Apple accepted key ${creds.keyId}, but its team has no app with bundle ID ${app.bundleId} (the team has ${total} app${total === 1 ? "" : "s"}). The key belongs to another team, or the bundle ID in App details is wrong. Create the key in the App Store Connect team that owns this app.`
        : `Apple accepted key ${creds.keyId}, but its team has no apps, so it cannot see bundle ID ${app.bundleId}. Create the key in the App Store Connect team that owns this app.`, extra);
    }
    step = "products";
    const id = encodeURIComponent(found.id);
    const groups = await api.send<{ meta?: { paging?: { total?: number } } }>("GET", `/v1/apps/${id}/subscriptionGroups?limit=1&fields[subscriptionGroups]=referenceName`);
    const iaps = await api.send<{ meta?: { paging?: { total?: number } } }>("GET", `/v1/apps/${id}/inAppPurchasesV2?limit=1&fields[inAppPurchases]=productId`);
    const name = typeof found.attributes?.name === "string" ? found.attributes.name : app.bundleId;
    const nGroups = groups.meta?.paging?.total ?? 0, nIaps = iaps.meta?.paging?.total ?? 0;
    return {
      status: "valid",
      message: `Key ${creds.keyId} works: it sees ${name} (Apple ID ${found.id}) and can read its ${nGroups} subscription group${nGroups === 1 ? "" : "s"} and ${nIaps} in-app purchase${nIaps === 1 ? "" : "s"}. Creating products and changing prices needs the ${ROLE} role, which Apple checks only when RevenueDot writes.`,
      extra: { ...extra, app_store_app_id: found.id, app_name: name, subscription_groups: nGroups, in_app_purchases: nIaps },
    };
  } catch (e) {
    if (!(e instanceof ConnectError)) throw e;
    if (e.kind === "unavailable") return { status: "unreachable", message: e.message, extra };
    if (e.kind === "credentials" && !e.status) return invalid(`${e.message} Upload the AuthKey_${creds.keyId}.p8 file App Store Connect gave you, unchanged.`, extra);
    if (e.status === 401) {
      const c = app.credentials ?? {};
      const iapKeyId = typeof c.subscription_key_id === "string" ? c.subscription_key_id.trim() : null;
      if (iapKeyId && iapKeyId === creds.keyId) {
        return invalid(`Key ${creds.keyId} is this app's In-App Purchase key, and App Store Connect does not accept In-App Purchase keys. Create a team key with the ${ROLE} role under Users and Access → Integrations → App Store Connect API.`, extra);
      }
      return invalid(`Apple did not accept the key (401). The key ID, issuer ID and .p8 file must belong to one team key: check that the key ID matches the file name AuthKey_${creds.keyId}.p8, that the issuer ID is the one shown above the team keys list (not an individual key), and that the key is not revoked. An In-App Purchase key (SubscriptionKey_….p8) does not work here.`, extra);
    }
    if (e.status === 403 && e.code && e.code !== "FORBIDDEN_ERROR") {
      // Not the role: Apple's own reason, such as FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED (the Paid Apps agreement).
      const said = e.message.replace(/^App Store Connect refused the API key \((.*)\)\. It needs the App Manager role\.$/s, "$1");
      return invalid(/AGREEMENT/i.test(e.code)
        ? `Apple refused the request (403 ${e.code}): an agreement is missing or expired. The Account Holder must accept the latest agreements under Business in App Store Connect. Apple said: ${said}`
        : `Apple refused the request (403 ${e.code}). Apple said: ${said}`, extra);
    }
    if (e.status === 403) {
      return invalid(step === "apps"
        ? `Apple accepted key ${creds.keyId} but refused to list apps (403). Give the key the ${ROLE} role under Users and Access → Integrations → App Store Connect API.`
        : `Key ${creds.keyId} sees the app but cannot read its subscriptions and in-app purchases (403). Give the key the ${ROLE} role under Users and Access → Integrations → App Store Connect API.`, extra);
    }
    return invalid(`App Store Connect refused the check: ${e.message}`, extra);
  }
}
