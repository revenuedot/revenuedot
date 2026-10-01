import { and, eq } from "drizzle-orm";
import { schema, type DB, type PaywallContent } from "@revenuedot/db";
import { fillLocales, uiLocalizations } from "@revenuedot/core";

/** Paywall content, the default `ui_config` the SDKs expect next to paywall components, and what an offering sends to the SDK. */

export type PaywallRow = typeof schema.paywalls.$inferSelect;

/** An empty vertical stack on a white background: valid components config the SDK renders as a blank screen. */
export const emptyComponentsConfig = () => ({
  base: {
    background: { type: "color", value: { light: { type: "hex", value: "#ffffffff" } } },
    stack: { id: "root", type: "stack", components: [], dimension: { type: "vertical", alignment: "center", distribution: "center" }, size: { width: { type: "fill" }, height: { type: "fill" } }, spacing: 16, margin: {}, padding: {} },
  },
});

export const newContent = (over: Partial<PaywallContent> = {}): PaywallContent => ({
  components_config: emptyComponentsConfig(), components_localizations: { en_US: {} }, default_locale: "en_US", automatically_scale_font_size: true,
  exit_offers: null, state_declarations: null, play_store_product_change_mode: null, revision: 1, ...over,
});

/**
 * Top-level `ui_config` of the offerings response. `fonts` maps a font key to the uploaded font, per platform;
 * `locales` are the locales the project's published paywalls use, which get the SDK's period and price words
 * (packages/core/src/paywalls/locales.ts) in their language.
 */
export function uiConfig(fonts: Record<string, unknown> = {}, locales: Iterable<string> = []) {
  return {
    app: { colors: {}, fonts },
    custom_variables: {},
    localizations: uiLocalizations(locales),
    variable_config: { function_compatibility_map: {}, variable_compatibility_map: {} },
  };
}

/** The locales of published paywalls. */
export const paywallLocales = (rows: Iterable<PaywallRow>) => {
  const out = new Set<string>();
  for (const r of rows) for (const l of Object.keys(r.published?.components_localizations ?? {})) out.add(l);
  return out;
};

/** A published version's strings with every locale completed from the default locale (the SDK shows "" for a missing key). */
export const servedLocalizations = (v: PaywallContent) => fillLocales(v.components_localizations ?? {}, v.default_locale ?? "en_US");

/** `paywall_components` for one offering of the SDK offerings response: the published version only. */
export function sdkPaywallComponents(p: PaywallRow, assetBaseUrl: string) {
  const v = p.published;
  if (!v?.components_config) return null;
  return {
    id: p.id, template_name: "components", asset_base_url: assetBaseUrl, revision: v.revision,
    // Storefronts where prices show without decimals ("$60" not "$60.00"), keyed by store as the SDKs decode it.
    zero_decimal_place_countries: { apple: ["TWN", "KAZ", "MEX", "PHL", "THA"], google: ["TW", "KZ", "MX", "PH", "TH"] },
    components_config: v.components_config, components_localizations: servedLocalizations(v), default_locale: v.default_locale ?? "en_US",
    ...(v.exit_offers ? { exit_offers: v.exit_offers } : {}), automatically_scale_font_size: v.automatically_scale_font_size,
    ...(v.state_declarations ? { state_declarations: v.state_declarations } : {}),
  };
}

/** Published paywalls of a project, by offering id. */
export async function publishedByOffering(db: DB, projectId: string): Promise<Map<string, PaywallRow>> {
  const rows = await db.select().from(schema.paywalls).where(eq(schema.paywalls.projectId, projectId));
  return new Map(rows.filter((r) => r.offeringId && r.published).map((r) => [r.offeringId!, r]));
}

/** Uploaded fonts as `ui_config.app.fonts` entries, keyed by font key. */
export async function fontConfig(db: DB, projectId: string, assetBaseUrl: string): Promise<Record<string, unknown>> {
  const rows = await db.select().from(schema.mediaAssets).where(and(eq(schema.mediaAssets.projectId, projectId), eq(schema.mediaAssets.kind, "font")));
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const m = r.meta as { name: string; family_name: string; hash: string };
    const info = { type: "name", value: m.name, family: m.family_name, url: `${assetBaseUrl}/${r.objectName}`, hash: m.hash };
    out[fontKey(r)] = { ios: info, android: info, web: info };
  }
  return out;
}
export const fontKey = (r: { id: string }) => `font_${r.id}`;

// ---- Image and font metadata ----------------------------------------------------------------------------------------

/** Width and height of a PNG, JPEG or WebP, or nulls for other formats. */
export function imageSize(b: Uint8Array): { width: number | null; height: number | null } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const none = { width: null, height: null };
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: dv.getUint32(16), height: dv.getUint32(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      i += 2 + dv.getUint16(i + 2);
    }
    return none;
  }
  if (b.length > 30 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") {
    const kind = String.fromCharCode(...b.slice(12, 16));
    if (kind === "VP8X") return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    if (kind === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (kind === "VP8L") { const bits = dv.getUint32(21, true); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
  }
  return none;
}

/** PostScript name, family, style and weight of a TrueType or OpenType font, read from its `name` and `OS/2` tables. */
export function fontInfo(b: Uint8Array): { name: string; family_name: string; style: "normal" | "italic"; weight: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 12) return null;
  const tag = String.fromCharCode(...b.slice(0, 4));
  if (!["\u0000\u0001\u0000\u0000", "OTTO", "true"].includes(tag)) return null;
  const tables = new Map<string, number>();
  for (let i = 0; i < dv.getUint16(4); i++) {
    const at = 12 + i * 16;
    if (at + 16 > b.length) return null;
    tables.set(String.fromCharCode(...b.slice(at, at + 4)), dv.getUint32(at + 8));
  }
  const nameAt = tables.get("name");
  if (nameAt === undefined || nameAt + 6 > b.length) return null;
  const count = dv.getUint16(nameAt + 2), strings = nameAt + dv.getUint16(nameAt + 4);
  const names: Record<number, string> = {};
  for (let i = 0; i < count; i++) {
    const at = nameAt + 6 + i * 12;
    if (at + 12 > b.length) break;
    const platform = dv.getUint16(at), id = dv.getUint16(at + 6), len = dv.getUint16(at + 8), off = strings + dv.getUint16(at + 10);
    if (![1, 2, 4, 6, 16, 17].includes(id) || off + len > b.length || (names[id] && platform !== 3)) continue;
    const raw = b.slice(off, off + len);
    names[id] = platform === 3 || platform === 0 ? new TextDecoder("utf-16be").decode(raw) : new TextDecoder("latin1").decode(raw);
  }
  const family = names[16] ?? names[1];
  const ps = names[6];
  if (!family || !ps) return null;
  let weight = 400, italic = /italic|oblique/i.test(names[17] ?? names[2] ?? "");
  const os2 = tables.get("OS/2");
  if (os2 !== undefined && os2 + 64 <= b.length) { weight = dv.getUint16(os2 + 4); italic = italic || (dv.getUint16(os2 + 62) & 1) === 1; }
  return { name: ps, family_name: family, style: italic ? "italic" : "normal", weight };
}

export const b64decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** MD5 of the bytes as hex. The SDKs verify downloaded fonts against it. WebCrypto has no MD5 on Node, so this is plain code. */
export async function md5Hex(input: Uint8Array): Promise<string> {
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const R = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const len = input.length;
  const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
  padded.set(input); padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, (len * 8) >>> 0, true); dv.setUint32(padded.length - 4, Math.floor(len / 2 ** 29), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let o = 0; o < padded.length; o += 64) {
    const M = Array.from({ length: 16 }, (_, i) => dv.getUint32(o + i * 4, true));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i]! + M[g]!) >>> 0; A = D; D = C; C = B; B = (B + ((F << R[i]!) | (F >>> (32 - R[i]!)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16), ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return [...out].map((x) => x.toString(16).padStart(2, "0")).join("");
}
