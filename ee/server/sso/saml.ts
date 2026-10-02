// RevenueDot Enterprise (ee/LICENSE). SAML 2.0 service provider: SP-initiated sign-in (HTTP-Redirect), the assertion
// consumer (HTTP-POST), SP metadata, IdP metadata parsing and certificate checks. Signature checks are node-saml's;
// this file adds the checks node-saml 5.1 leaves to the caller. Spec: prd/enterprise/PRD.md §5.
import * as nodeCrypto from "node:crypto";
import { SAML, ValidateInResponseTo, type CacheItem, type CacheProvider, type Profile } from "@node-saml/node-saml";
import { DOMParser } from "@xmldom/xmldom";
import { and, eq, gt } from "drizzle-orm";
import type { DB } from "@revenuedot/db";
import { eeSamlAssertions, eeSsoRequests, type SamlConfig } from "../schema.js";
import { randomHex } from "../util.js";

export const SAML_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const MD_NS = "urn:oasis:names:tc:SAML:2.0:metadata";
const DS_NS = "http://www.w3.org/2000/09/xmldsig#";
const REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const REQUEST_TTL_MS = 10 * 60_000;
const SKEW_MS = 60_000;

export const samlUrls = (base: string, id: string) => ({
  entity_id: `${base}/sso/saml/${id}/metadata`,
  acs_url: `${base}/sso/saml/${id}/acs`,
  metadata_url: `${base}/sso/saml/${id}/metadata`,
  start_url: `${base}/sso/connections/${id}/start`,
});

// ---------------------------------------------------------------------------------------------------------------------
// Certificates and IdP metadata

export class SamlConfigError extends Error {}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Reads one DER length at `i`; returns [length, offset of the contents] or null. */
function derLen(b: Uint8Array, i: number): [number, number] | null {
  const first = b[i];
  if (first === undefined) return null;
  if (first < 0x80) return [first, i + 1];
  const n = first & 0x7f;
  if (n < 1 || n > 4) return null;
  let len = 0;
  for (let k = 1; k <= n; k++) { const v = b[i + k]; if (v === undefined) return null; len = len * 256 + v; }
  return [len, i + 1 + n];
}

/** The outer shape of an X.509 certificate: SEQUENCE { SEQUENCE tbsCertificate, SEQUENCE algorithm, BIT STRING }. */
function looksLikeCertificate(der: Uint8Array): boolean {
  if (der[0] !== 0x30) return false;
  const outer = derLen(der, 1);
  if (!outer || outer[1] + outer[0] !== der.length) return false;
  let i = outer[1];
  for (const tag of [0x30, 0x30, 0x03]) {
    if (der[i] !== tag) return false;
    const l = derLen(der, i + 1);
    if (!l) return false;
    i = l[1] + l[0];
  }
  return i === der.length;
}

/**
 * A certificate given as PEM or base64 DER, returned as PEM. Node's X509Certificate parses it fully where the runtime
 * has it; elsewhere the DER structure is checked, and node-saml rejects a bad key when it verifies.
 */
export function normalizeCertificate(input: string): string {
  const blocks = input.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0;
  if (blocks > 1) throw new SamlConfigError("Enter one certificate per entry.");
  const body = input.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length > 20_000) throw new SamlConfigError("is not a PEM or base64 X.509 certificate.");
  let der: Uint8Array;
  try { der = b64decode(body); } catch { throw new SamlConfigError("is not valid base64."); }
  if (!looksLikeCertificate(der)) throw new SamlConfigError("is not an X.509 certificate.");
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----`;
  const X509 = (nodeCrypto as { X509Certificate?: new (b: string) => unknown }).X509Certificate;
  if (typeof X509 === "function") {
    try { new X509(pem); } catch { throw new SamlConfigError("is not a valid X.509 certificate."); }
  }
  return pem;
}

export function parseXml(xml: string): Document {
  const fail = (m: string) => { throw new SamlConfigError(`The XML could not be read: ${m}`); };
  const doc = new DOMParser({ errorHandler: { warning: () => {}, error: fail, fatalError: fail } }).parseFromString(xml, "text/xml");
  if (!doc?.documentElement) throw new SamlConfigError("The XML has no root element.");
  return doc;
}

const elements = (parent: Node | null | undefined, ns: string, local: string): Element[] => {
  const out: Element[] = [];
  for (let n = parent?.firstChild ?? null; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).namespaceURI === ns && (n as Element).localName === local) out.push(n as Element);
  }
  return out;
};
const first = (parent: Node | null | undefined, ns: string, local: string) => elements(parent, ns, local)[0] ?? null;
const text = (e: Element | null) => (e?.textContent ?? "").trim();

/** Reads an identity provider's metadata: entity id, HTTP-Redirect sign-in URL and signing certificates. */
export function parseIdpMetadata(xml: string): { idp_entity_id: string; idp_sso_url: string; idp_certificates: string[] } {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  const candidates = root.localName === "EntityDescriptor" ? [root] : Array.from(doc.getElementsByTagNameNS(MD_NS, "EntityDescriptor"));
  const entity = candidates.find((e) => first(e, MD_NS, "IDPSSODescriptor"));
  if (!entity) throw new SamlConfigError("The metadata has no EntityDescriptor with an IDPSSODescriptor.");
  const idp = first(entity, MD_NS, "IDPSSODescriptor")!;
  const sso = elements(idp, MD_NS, "SingleSignOnService").find((e) => e.getAttribute("Binding") === REDIRECT_BINDING);
  if (!sso?.getAttribute("Location")) throw new SamlConfigError("The metadata has no SingleSignOnService with the HTTP-Redirect binding.");
  const certs: string[] = [];
  for (const kd of elements(idp, MD_NS, "KeyDescriptor")) {
    const use = kd.getAttribute("use");
    if (use && use !== "signing") continue;
    for (const ki of elements(kd, DS_NS, "KeyInfo")) for (const xd of elements(ki, DS_NS, "X509Data")) for (const c of elements(xd, DS_NS, "X509Certificate")) {
      const pem = normalizeCertificate(text(c));
      if (!certs.includes(pem)) certs.push(pem);
    }
  }
  if (!certs.length) throw new SamlConfigError("The metadata has no signing certificate.");
  return { idp_entity_id: entity.getAttribute("entityID") ?? "", idp_sso_url: sso.getAttribute("Location")!, idp_certificates: certs };
}

// ---------------------------------------------------------------------------------------------------------------------
// Requests in flight, in Postgres so every server (and Workers isolate) shares them

/**
 * node-saml's CacheProvider over ee_sso_requests, scoped to one connection. It remembers which request ids node-saml
 * found (and their return paths), so the caller can tell whether the signed InResponseTo was really checked.
 */
export class PgRequestCache implements CacheProvider {
  readonly found = new Map<string, string | null>();
  constructor(private db: DB, private connectionId: string, private now: () => Date, private returnTo: string | null = null) {}

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    const now = this.now();
    const [row] = await this.db.insert(eeSsoRequests).values({ id: key, connectionId: this.connectionId, value, returnTo: this.returnTo, expiresAt: new Date(now.getTime() + REQUEST_TTL_MS), createdAt: now })
      .onConflictDoNothing().returning();
    return row ? { value, createdAt: now.getTime() } : null;
  }

  async getAsync(key: string): Promise<string | null> {
    if (!key) return null;
    const [row] = await this.db.select().from(eeSsoRequests)
      .where(and(eq(eeSsoRequests.id, key), eq(eeSsoRequests.connectionId, this.connectionId), gt(eeSsoRequests.expiresAt, this.now()))).limit(1);
    if (!row) return null;
    this.found.set(key, row.returnTo);
    return row.value;
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (!key) return null;
    const [row] = await this.db.delete(eeSsoRequests).where(and(eq(eeSsoRequests.id, key), eq(eeSsoRequests.connectionId, this.connectionId))).returning();
    return row?.value ?? null;
  }
}

function client(base: string, connectionId: string, cfg: SamlConfig, cache: CacheProvider, requestId?: string) {
  const urls = samlUrls(base, connectionId);
  return new SAML({
    callbackUrl: urls.acs_url, issuer: urls.entity_id, audience: urls.entity_id, entryPoint: cfg.idp_sso_url, idpCert: cfg.idp_certificates,
    wantAssertionsSigned: true, wantAuthnResponseSigned: false, validateInResponseTo: ValidateInResponseTo.ifPresent,
    requestIdExpirationPeriodMs: REQUEST_TTL_MS, acceptedClockSkewMs: SKEW_MS, identifierFormat: null, disableRequestedAuthnContext: true,
    signatureAlgorithm: "sha256", digestAlgorithm: "sha256", cacheProvider: cache,
    ...(requestId ? { generateUniqueId: () => requestId } : {}),
  });
}

/** The identity provider URL that starts an SP-initiated sign-in. The request id is stored with the return path. */
export async function samlStartUrl(db: DB, now: () => Date, base: string, connectionId: string, cfg: SamlConfig, next: string): Promise<{ url: string; requestId: string }> {
  const cache = new PgRequestCache(db, connectionId, now, next);
  const requestId = `_${randomHex(20)}`;
  return { url: await client(base, connectionId, cfg, cache, requestId).getAuthorizeUrlAsync(next, undefined, {}), requestId };
}

export function samlMetadata(base: string, connectionId: string, cfg: SamlConfig): string {
  const unused: CacheProvider = { saveAsync: async () => null, getAsync: async () => null, removeAsync: async () => null };
  return client(base, connectionId, cfg, unused).generateServiceProviderMetadata(null, null);
}

// ---------------------------------------------------------------------------------------------------------------------
// The assertion consumer

export interface SsoIdentity { email: string; name: string | null; groups: string[] }
export type AcsResult =
  | { ok: true; identity: SsoIdentity; next: string | null; idpInitiated: boolean; assertionId: string; requestId: string | null }
  | { ok: false; reason: string };

const EMAIL_ATTRS = ["email", "mail", "emailaddress", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "urn:oid:0.9.2342.19200300.100.1.3"];
const GROUP_ATTRS = ["groups", "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups"];
const FIRST_ATTRS = ["givenname", "firstname", "first_name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname", "urn:oid:2.5.4.42"];
const LAST_ATTRS = ["sn", "surname", "lastname", "last_name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname", "urn:oid:2.5.4.4"];
const NAME_ATTRS = ["displayname", "name", "http://schemas.microsoft.com/identity/claims/displayname"];
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Attribute values by name: exact name first, then the default names case-insensitively. */
function attrPicker(assertion: Element) {
  const map = new Map<string, string[]>();
  for (const st of elements(assertion, SAML_NS, "AttributeStatement")) for (const a of elements(st, SAML_NS, "Attribute")) {
    const name = a.getAttribute("Name");
    if (!name) continue;
    const values = elements(a, SAML_NS, "AttributeValue").map(text).filter(Boolean);
    map.set(name, [...(map.get(name) ?? []), ...values]);
  }
  const lower = new Map<string, string[]>();
  for (const [k, v] of map) lower.set(k.toLowerCase(), [...(lower.get(k.toLowerCase()) ?? []), ...v]);
  return (configured: string | null | undefined, defaults: string[]): string[] => {
    if (configured) return map.get(configured) ?? [];
    for (const d of defaults) { const v = lower.get(d.toLowerCase()); if (v?.length) return v; }
    return [];
  };
}

const dateMs = (s: string | null) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };

/**
 * Validates a SAMLResponse posted to the ACS. node-saml checks the signature (and reads only the signed XML), the
 * time conditions, the audience and the InResponseTo of the Response against requests in flight. Then, on the signed
 * assertion only: Recipient, Issuer, the signed InResponseTo, IdP-initiated sign-in, and replay. The Response element
 * itself is unsigned, so its Destination and InResponseTo are only compared, never trusted.
 */
export async function samlConsume(db: DB, now: () => Date, base: string, connectionId: string, cfg: SamlConfig, form: { SAMLResponse: string; RelayState?: string }): Promise<AcsResult> {
  const urls = samlUrls(base, connectionId);
  const cache = new PgRequestCache(db, connectionId, now);
  let profile: Profile | null;
  try {
    ({ profile } = await client(base, connectionId, cfg, cache).validatePostResponseAsync({ SAMLResponse: form.SAMLResponse, ...(form.RelayState ? { RelayState: form.RelayState } : {}) }));
  } catch (e) {
    return { ok: false, reason: `node-saml: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
  }
  if (!profile?.getAssertionXml) return { ok: false, reason: "no assertion in the response" };

  let assertion: Element, response: Element;
  try {
    assertion = parseXml(profile.getAssertionXml()).documentElement;
    response = parseXml(new TextDecoder().decode(b64decode(form.SAMLResponse.replace(/\s+/g, "")))).documentElement;
  } catch {
    return { ok: false, reason: "the response XML could not be read" };
  }
  if (assertion.namespaceURI !== SAML_NS || assertion.localName !== "Assertion") return { ok: false, reason: "the signed element is not an Assertion" };
  const assertionId = assertion.getAttribute("ID");
  if (!assertionId) return { ok: false, reason: "the assertion has no ID" };

  const destination = response.getAttribute("Destination");
  if (destination && destination !== urls.acs_url) return { ok: false, reason: `Response Destination ${destination.slice(0, 200)} is not this connection's ACS URL` };

  const issuer = text(first(assertion, SAML_NS, "Issuer"));
  if (issuer !== cfg.idp_entity_id.trim()) return { ok: false, reason: `assertion Issuer ${issuer.slice(0, 200) || "(none)"} is not the configured IdP entity id` };

  const conditions = first(assertion, SAML_NS, "Conditions");
  const audiences = elements(conditions, SAML_NS, "AudienceRestriction").flatMap((ar) => elements(ar, SAML_NS, "Audience").map(text));
  if (!audiences.includes(urls.entity_id)) return { ok: false, reason: "the assertion has no AudienceRestriction for this connection" };

  const subject = first(assertion, SAML_NS, "Subject");
  const bearer = elements(subject, SAML_NS, "SubjectConfirmation").filter((sc) => sc.getAttribute("Method") === BEARER).map((sc) => first(sc, SAML_NS, "SubjectConfirmationData"));
  if (!bearer.length || bearer.some((d) => !d)) return { ok: false, reason: "the assertion has no bearer SubjectConfirmationData" };
  const data = bearer as Element[];
  if (data.some((d) => d.getAttribute("Recipient") !== urls.acs_url)) return { ok: false, reason: "SubjectConfirmationData Recipient is not this connection's ACS URL" };
  const irts = [...new Set(data.map((d) => d.getAttribute("InResponseTo") || null))];
  if (irts.length > 1) return { ok: false, reason: "the bearer confirmations disagree on InResponseTo" };
  const signedIrt = irts[0] ?? null;
  const responseIrt = response.getAttribute("InResponseTo") || null;

  let next: string | null = null;
  if (signedIrt) {
    // node-saml consults the request store only when the unsigned Response carries InResponseTo, so require that it
    // did, for this very id (a stripped or different Response InResponseTo is refused).
    if (responseIrt !== signedIrt || !cache.found.has(signedIrt)) return { ok: false, reason: "InResponseTo does not match a sign-in started here" };
    next = cache.found.get(signedIrt) ?? null;
  } else if (!cfg.allow_idp_initiated) {
    // Without a signed InResponseTo the assertion is IdP-initiated, whatever the unsigned Response says.
    return { ok: false, reason: "IdP-initiated sign-in is turned off for this connection" };
  }

  const nowMs = now().getTime();
  const ends = [dateMs(conditions?.getAttribute("NotOnOrAfter") ?? null), ...data.map((d) => dateMs(d.getAttribute("NotOnOrAfter")))].filter((x): x is number => x !== null);
  const expiresAt = new Date((ends.length ? Math.max(...ends) : nowMs + REQUEST_TTL_MS) + SKEW_MS);
  const [fresh] = await db.insert(eeSamlAssertions).values({ connectionId, assertionId, expiresAt }).onConflictDoNothing().returning();
  if (!fresh) return { ok: false, reason: `assertion ${assertionId.slice(0, 100)} was already used (replay)` };

  const pick = attrPicker(assertion);
  const nameId = text(first(subject, SAML_NS, "NameID"));
  const email = (pick(cfg.email_attribute, EMAIL_ATTRS)[0] ?? (EMAIL_RE.test(nameId) ? nameId : "")).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, reason: "the assertion has no email address (attribute or NameID)" };
  const groups = pick(cfg.groups_attribute, GROUP_ATTRS);
  const firstName = pick(cfg.first_name_attribute, FIRST_ATTRS)[0] ?? "";
  const lastName = pick(cfg.last_name_attribute, LAST_ATTRS)[0] ?? "";
  const name = [firstName, lastName].filter(Boolean).join(" ") || pick(null, NAME_ATTRS)[0] || null;
  return { ok: true, identity: { email, name: name ? name.slice(0, 100) : null, groups }, next, idpInitiated: !signedIrt, assertionId, requestId: signedIrt };
}
