import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { fontConfig, paywallLocales, servedLocalizations, uiConfig } from "./paywalls.js";

/**
 * Remote configuration for the SDKs (`POST /v1/config/app`). RevenueCat SDKs from iOS 5.83 on load paywalls only from
 * here, as "workflows": the offerings response's `paywall_components` is no longer decoded (iOS 5.89+).
 *
 * The response is an RC Container (`application/x-rc-format`), little-endian:
 *   header  8 bytes: "R" "C" 0x01 0x00 0 0 0 0
 *   element checksum[24] | size u32 | encoding u8 (0 = none) | 3 zero bytes | payload | zero padding to a multiple of 8
 * Element 0 is the configuration JSON; the other elements are the blobs it references, inlined so no CDN is needed.
 * A checksum is the first 24 bytes of SHA-256 of the payload; a blob ref is that checksum in base64url without padding.
 * Blobs are also kept in `config_blobs` and served at `GET /blobs/{ref}` (the `sources` topic says so) for SDKs that
 * download a blob instead of taking it inline.
 */

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function checksum(b: Uint8Array) { return new Uint8Array(await crypto.subtle.digest("SHA-256", b as unknown as ArrayBuffer)).slice(0, 24); }
export async function blobRef(b: Uint8Array) { return b64url(await checksum(b)); }

export async function container(elements: Uint8Array[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [Uint8Array.from([0x52, 0x43, 0x01, 0, 0, 0, 0, 0])];
  for (const [i, p] of elements.entries()) {
    const head = new Uint8Array(32);
    head.set(await checksum(p), 0);
    new DataView(head.buffer).setUint32(24, p.length, true);
    parts.push(head, p);
    const pad = (8 - (p.length % 8)) % 8;
    if (pad && i < elements.length - 1) parts.push(new Uint8Array(pad));
  }
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) { out.set(x, at); at += x.length; }
  return out;
}

/** Reads a container back (tests, and checking what was sent). */
export function parseContainer(b: Uint8Array): { checksum: Uint8Array; payload: Uint8Array }[] {
  if (b[0] !== 0x52 || b[1] !== 0x43 || b[2] !== 1) throw new Error("not an RC container");
  const out = [];
  let at = 8;
  while (at + 32 <= b.length) {
    const size = new DataView(b.buffer, b.byteOffset + at + 24, 4).getUint32(0, true);
    out.push({ checksum: b.slice(at, at + 24), payload: b.slice(at + 32, at + 32 + size) });
    at += 32 + size + ((8 - (size % 8)) % 8);
  }
  return out;
}

/** A `PublishedWorkflow` with one paywall screen for one offering, from a published paywall. */
export function workflowFor(p: typeof schema.paywalls.$inferSelect, offeringKey: string, assetBaseUrl: string) {
  const v = p.published!;
  return {
    id: `wf_${p.id}`, display_name: p.name ?? "Paywall", initial_step_id: "step_1", single_step_fallback_id: "step_1",
    steps: { step_1: { id: "step_1", type: "screen", screen_id: "screen_1", param_values: { offering: { identifier: offeringKey } }, metadata: { screen_type: ["paywall"] } } },
    screens: {
      screen_1: {
        template_name: "components", revision: v.revision, asset_base_url: assetBaseUrl, offering_identifier: offeringKey, default_locale: v.default_locale ?? "en_US",
        components_config: v.components_config, components_localizations: servedLocalizations(v),
        automatically_scale_font_size: v.automatically_scale_font_size, zero_decimal_place_countries: { apple: ["TWN", "KAZ", "MEX", "PHL", "THA"], google: ["TW", "KZ", "MX", "PH", "TH"] },
        ...(v.exit_offers ? { exit_offers: v.exit_offers } : {}), ...(v.state_declarations ? { state_declarations: v.state_declarations } : {}),
      },
    },
  };
}

export interface Built { body: Uint8Array | null; manifest: string }

/**
 * Builds the configuration for a project. `known` is the manifest the SDK sent: when nothing changed the caller answers
 * 204. `prefetched` lists blob refs the SDK already holds, which are not inlined again.
 */
export async function buildRemoteConfig(db: DB, projectId: string, origin: string, known: string | null, prefetched: string[]): Promise<Built> {
  const assetBase = `${origin}/assets/${projectId}`;
  const pws = await db.select().from(schema.paywalls).where(eq(schema.paywalls.projectId, projectId));
  const ui = uiConfig(await fontConfig(db, projectId, assetBase), paywallLocales(pws));
  const blobs = new Map<string, Uint8Array>();
  const addBlob = async (value: unknown) => { const bytes = enc.encode(JSON.stringify(value)); const ref = await blobRef(bytes); blobs.set(ref, bytes); return ref; };
  const uiItems: Record<string, { blob_ref: string; prefetch: boolean }> = {};
  for (const k of ["app", "localizations", "variable_config", "custom_variables"] as const) uiItems[k] = { blob_ref: await addBlob(ui[k]), prefetch: true };

  const offs = await db.select({ id: schema.offerings.id, key: schema.offerings.lookupKey }).from(schema.offerings).where(and(eq(schema.offerings.projectId, projectId), eq(schema.offerings.state, "active")));
  const workflows: Record<string, Record<string, unknown>> = {};
  for (const p of pws.sort((a, b) => a.id.localeCompare(b.id))) {
    const key = offs.find((o) => o.id === p.offeringId)?.key;
    if (!p.published?.components_config || !key) continue;
    workflows[`wf_${p.id}`] = { blob_ref: await addBlob(workflowFor(p, key, assetBase)), prefetch: true, offering_identifier: key };
  }
  const topics = {
    sources: { blob: { sources: [{ url_format: `${origin}/blobs/{blob_ref}`, priority: 0, weight: 100 }] } },
    ui_config: uiItems,
    workflows,
  };
  // The manifest changes whenever any topic changes; the SDK echoes it back and gets 204 while it is unchanged.
  const manifest = `v1.${await blobRef(enc.encode(JSON.stringify(topics)))}`;
  if (known === manifest) return { body: null, manifest };
  for (const [ref, bytes] of blobs) {
    await db.insert(schema.configBlobs).values({ ref, data: new TextDecoder().decode(bytes) }).onConflictDoNothing();
  }
  const config = { domain: "app", manifest, active_topics: Object.keys(topics), prefetch_blobs: [], topics };
  const inline = [...blobs.entries()].filter(([ref]) => !prefetched.includes(ref)).map(([, b]) => b);
  return { body: await container([enc.encode(JSON.stringify(config)), ...inline]), manifest };
}
