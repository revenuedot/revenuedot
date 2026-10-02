import { and, asc, eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import type { AppRecord } from "../context.js";
import { appleCredentials, AppleApiClientError, type AppleEnv, type AppStoreServerApi } from "../stores/apple/api.js";
import { signOffer } from "./promo-offers.js";

/**
 * Retention (prd/lifecycle/PRD.md):
 * - Customer Center offers: a promotional offer on the CANCEL and REFUND_REQUEST paths of the configuration the SDKs load.
 * - Apple's Retention Messaging API: messages RevenueDot uploads to Apple, default messages per product and locale, and the
 *   real-time "Get Retention Message" endpoint Apple calls when a customer is about to cancel.
 */

type Json = Record<string, unknown>;
export type OfferRow = typeof schema.retentionOffers.$inferSelect;

/** The SDKs' `promotional_offer` path detail; both SDKs read their own offer id key and ignore the other. */
export function promotionalOfferFor(offers: OfferRow[]): Json | null {
  const live = offers.filter((o) => o.active);
  if (!live.length) return null;
  const mapping: Record<string, string> = {};
  for (const o of live) Object.assign(mapping, o.productMapping);
  // The SDKs look up product_mapping by the customer's product first; the top-level id is a fallback: the first offer's
  // id for the alphabetically first product (Postgres keeps JSON keys in its own order, so order by key).
  const first = (store: string) => {
    const o = live.find((x) => x.store === store && Object.keys(x.productMapping).length);
    return o ? o.productMapping[Object.keys(o.productMapping).sort()[0]!]! : "";
  };
  const lead = live[0]!;
  return { ios_offer_id: first("app_store"), android_offer_id: first("play_store"), eligible: true, title: lead.title, subtitle: lead.subtitle, product_mapping: mapping };
}

/** Adds the cancel and refund offers to every matching path with no `promotional_offer` key of the Customer Center configuration (pure; returns a copy). */
export function withRetentionOffers(config: Json, offers: OfferRow[]): Json {
  const cancel = promotionalOfferFor(offers.filter((o) => o.trigger === "cancel"));
  const refund = promotionalOfferFor(offers.filter((o) => o.trigger === "refund"));
  if (!cancel && !refund) return config;
  const screens = (config.screens ?? {}) as Record<string, Json>;
  const out: Record<string, Json> = {};
  for (const [k, screen] of Object.entries(screens)) {
    const paths = Array.isArray(screen.paths) ? screen.paths as Json[] : [];
    out[k] = {
      ...screen,
      paths: paths.map((p) => {
        const offer = p.type === "CANCEL" ? cancel : p.type === "REFUND_REQUEST" ? refund : null;
        // A path's own offer, a reference, or null ("no offer", set in the editor) keeps the Retention offers off it.
        return offer && p.promotional_offer === undefined ? { ...p, promotional_offer: offer } : p;
      }),
    };
  }
  return { ...config, screens: out };
}

export async function retentionOffersOf(db: DB, projectId: string): Promise<OfferRow[]> {
  return db.select().from(schema.retentionOffers).where(eq(schema.retentionOffers.projectId, projectId)).orderBy(asc(schema.retentionOffers.createdAt));
}

// ---------- Apple Retention Messaging ----------

export interface RetentionMessage {
  /** A UUID: Apple's messageIdentifier. */
  id: string;
  kind: "text" | "switch_plan" | "promotional_offer";
  header: string;
  body: string;
  /** switch_plan: the product to suggest (same subscription group). */
  alternate_product_id?: string | null;
  /** promotional_offer: the App Store promotional offer id. */
  promotional_offer_id?: string | null;
  /** Environments Apple accepted the upload in. */
  uploaded?: AppleEnv[];
  error?: string | null;
}
export interface MessagingConfig {
  enabled: boolean;
  messages: RetentionMessage[];
  /** Apple shows these when the real-time call fails or is not configured; text messages only. */
  defaults: { product_id: string; locale: string; message_id: string; configured?: AppleEnv[] }[];
  /** Real-time answer: the first rule whose product matches (null = any product) picks the message. */
  rules: { product_id: string | null; message_id: string }[];
  realtime_url_configured?: Partial<Record<AppleEnv, number>>;
  stats?: { requests: number; answered: number; last_request_at: number | null; last_environment: string | null };
}

export const emptyMessaging = (): MessagingConfig => ({ enabled: false, messages: [], defaults: [], rules: [], realtime_url_configured: {}, stats: { requests: 0, answered: 0, last_request_at: null, last_environment: null } });
export function messagingOf(app: Pick<AppRecord, "retentionMessaging">): MessagingConfig {
  const raw = (app.retentionMessaging ?? {}) as Partial<MessagingConfig>;
  return { ...emptyMessaging(), ...raw, stats: { ...emptyMessaging().stats!, ...(raw.stats ?? {}) } };
}

/** Apple's limits (Upload Message): header 66, body 144 characters; offer and switch-plan messages have no image. */
export function messageProblems(m: RetentionMessage): string | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m.id)) return "id must be a UUID (Apple's messageIdentifier).";
  if (!m.header.trim() || [...m.header].length > 66) return "header needs 1 to 66 characters.";
  if (!m.body.trim() || [...m.body].length > 144) return "body needs 1 to 144 characters.";
  if (m.kind === "switch_plan" && !m.alternate_product_id) return "a switch-plan message needs alternate_product_id.";
  if (m.kind === "promotional_offer" && !m.promotional_offer_id) return "a promotional-offer message needs promotional_offer_id.";
  return null;
}

/** DecodedRealtimeRequestBody. */
export interface RealtimeRequest { originalTransactionId: string; appAppleId: number | string; productId: string; userLocale: string; requestIdentifier: string; environment: string; signedDate: number }

/**
 * The RealtimeResponseBody for one request: `message`, `alternateProduct` or `promotionalOffer` (signed with the app's
 * In-App Purchase key, promotionalOfferSignatureV1), or `{}` so Apple shows the default message.
 */
export async function realtimeAnswer(cfg: MessagingConfig, req: RealtimeRequest, app: AppRecord, now: Date): Promise<Json> {
  if (!cfg.enabled) return {};
  const rule = cfg.rules.find((r) => !r.product_id || r.product_id === req.productId);
  const m = rule && cfg.messages.find((x) => x.id === rule.message_id);
  if (!m) return {};
  if (m.kind === "text") return { message: { messageIdentifier: m.id } };
  if (m.kind === "switch_plan") return { alternateProduct: { messageIdentifier: m.id, productId: m.alternate_product_id } };
  const creds = appleCredentials(app);
  if (!creds || !m.promotional_offer_id) return {};
  const sig = await signOffer(creds, req.productId, m.promotional_offer_id, "", now);
  return {
    promotionalOffer: {
      messageIdentifier: m.id,
      promotionalOfferSignatureV1: { encodedSignature: sig.signature, productId: req.productId, nonce: sig.nonce, timestamp: sig.timestamp, keyId: sig.keyId, offerIdentifier: m.promotional_offer_id },
    },
  };
}

/**
 * "Sync to Apple": upload every message not yet in this environment, configure the defaults, and register the real-time
 * URL. Each step records its own result, so one failure does not hide the rest.
 */
export async function syncMessaging(db: DB, app: AppRecord, api: AppStoreServerApi, env: AppleEnv, realtimeUrl: string, now: Date) {
  const cfg = messagingOf(app);
  const errors: string[] = [];
  const reason = (e: unknown) => (e instanceof AppleApiClientError ? `Apple answered ${e.status}${e.errorCode ? ` (${e.errorCode})` : ""}: ${e.message}` : e instanceof Error ? e.message : String(e));
  for (const m of cfg.messages) {
    if (m.uploaded?.includes(env)) continue;
    try {
      await api.uploadRetentionMessage(env, m.id, { header: m.header, body: m.body });
      m.uploaded = [...(m.uploaded ?? []), env]; m.error = null;
    } catch (e) {
      // Upload Message is not idempotent: 409 MessageAlreadyExistsError means Apple has it.
      if (e instanceof AppleApiClientError && e.status === 409) { m.uploaded = [...(m.uploaded ?? []), env]; m.error = null; continue; }
      m.error = reason(e); errors.push(`Message "${m.header}": ${m.error}`);
    }
  }
  for (const d of cfg.defaults) {
    try {
      await api.configureDefaultRetentionMessage(env, d.product_id, d.locale, d.message_id);
      d.configured = [...new Set([...(d.configured ?? []), env])];
    } catch (e) { errors.push(`Default for ${d.product_id} (${d.locale}): ${reason(e)}`); }
  }
  try {
    await api.configureRealtimeUrl(env, realtimeUrl);
    cfg.realtime_url_configured = { ...(cfg.realtime_url_configured ?? {}), [env]: now.getTime() };
  } catch (e) { errors.push(`Real-time URL: ${reason(e)}`); }
  await db.update(schema.apps).set({ retentionMessaging: cfg as unknown as Json }).where(and(eq(schema.apps.id, app.id), eq(schema.apps.projectId, app.projectId)));
  return { config: cfg, errors };
}
