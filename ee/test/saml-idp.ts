// RevenueDot Enterprise (ee/LICENSE). A test SAML 2.0 identity provider: builds Responses with real timestamps and signs
// the Assertion with xml-crypto (exclusive c14n, enveloped signature, RSA-SHA256). Test only. Spec: prd/enterprise/PRD.md §5.
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { SignedXml } from "xml-crypto";

const fixture = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
export const IDP = {
  entityId: "https://idp.example.test/saml/metadata",
  ssoUrl: "https://idp.example.test/saml/sso",
  cert: fixture("idp-cert.pem"),
  key: fixture("idp-key.pem"),
  attackerCert: fixture("attacker-cert.pem"),
  attackerKey: fixture("attacker-key.pem"),
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
export const newId = () => `_${randomBytes(16).toString("hex")}`;

export interface AssertionOpts {
  /** The connection's ACS URL (Recipient, Destination) and entity id (Audience). */
  acsUrl: string;
  audience: string;
  email?: string;
  nameId?: string;
  inResponseTo?: string | null;
  issuer?: string;
  recipient?: string;
  attributes?: Record<string, string[]>;
  notBefore?: Date;
  notOnOrAfter?: Date;
  assertionId?: string;
}

/** An unsigned Assertion that declares its own namespace, so it signs and embeds the same way. */
export function assertionXml(o: AssertionOpts): string {
  const now = new Date();
  const notBefore = o.notBefore ?? new Date(now.getTime() - 30_000);
  const notOnOrAfter = o.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000);
  const irt = o.inResponseTo ? ` InResponseTo="${esc(o.inResponseTo)}"` : "";
  const attrs = { ...(o.email ? { email: [o.email] } : {}), ...(o.attributes ?? {}) };
  const attrXml = Object.entries(attrs).map(([name, values]) =>
    `<saml:Attribute Name="${esc(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">${values.map((v) => `<saml:AttributeValue>${esc(v)}</saml:AttributeValue>`).join("")}</saml:Attribute>`).join("");
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${o.assertionId ?? newId()}" Version="2.0" IssueInstant="${iso(now)}">`
    + `<saml:Issuer>${esc(o.issuer ?? IDP.entityId)}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${esc(o.nameId ?? o.email ?? "nobody@example.test")}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(notOnOrAfter)}" Recipient="${esc(o.recipient ?? o.acsUrl)}"${irt}/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${iso(notBefore)}" NotOnOrAfter="${iso(notOnOrAfter)}"><saml:AudienceRestriction><saml:Audience>${esc(o.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${newId()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + (attrXml ? `<saml:AttributeStatement>${attrXml}</saml:AttributeStatement>` : "")
    + `</saml:Assertion>`;
}

/** Signs the (single) Assertion in `xml` with an enveloped signature placed after its Issuer. */
export function signAssertion(xml: string, privateKey = IDP.key, publicCert = IDP.cert): string {
  const sig = new SignedXml({
    privateKey, publicCert,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  sig.addReference({
    xpath: "/*[local-name(.)='Assertion']",
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
  });
  sig.computeSignature(xml, { location: { reference: "/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" } });
  return sig.getSignedXml();
}

export interface ResponseOpts { destination?: string | null; inResponseTo?: string | null; issuer?: string; extensions?: string }

/** A Response around the given (signed or not) assertions. */
export function responseXml(inner: string, o: ResponseOpts = {}): string {
  const dest = o.destination ? ` Destination="${esc(o.destination)}"` : "";
  const irt = o.inResponseTo ? ` InResponseTo="${esc(o.inResponseTo)}"` : "";
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${newId()}" Version="2.0" IssueInstant="${iso(new Date())}"${dest}${irt}>`
    + `<saml:Issuer>${esc(o.issuer ?? IDP.entityId)}</saml:Issuer>`
    + (o.extensions !== undefined ? `<samlp:Extensions>${o.extensions}</samlp:Extensions>` : "")
    + `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`
    + inner
    + `</samlp:Response>`;
}

export const b64 = (xml: string) => Buffer.from(xml, "utf8").toString("base64");

/** The usual case: one assertion signed by the IdP, in a Response addressed to the ACS. Returns base64. */
export function samlResponse(o: AssertionOpts & { response?: ResponseOpts; sign?: "idp" | "attacker" | false }): string {
  const a = assertionXml(o);
  const signed = o.sign === false ? a : o.sign === "attacker" ? signAssertion(a, IDP.attackerKey, IDP.attackerCert) : signAssertion(a);
  return b64(responseXml(signed, { destination: o.acsUrl, inResponseTo: o.inResponseTo ?? null, ...o.response }));
}

/** Reads the AuthnRequest a SAML start redirect carries (HTTP-Redirect binding: deflate + base64). */
export function readAuthnRequest(location: string): { id: string; xml: string; relayState: string | null; url: URL } {
  const url = new URL(location);
  const xml = inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest") ?? "", "base64")).toString("utf8");
  const id = /\bID="([^"]+)"/.exec(xml)?.[1];
  if (!id) throw new Error(`no ID in AuthnRequest: ${xml}`);
  return { id, xml, relayState: url.searchParams.get("RelayState"), url };
}

// ---- Shared by the SSO tests: DNS over HTTPS answers and verified domains -----------------------------------------

/** TXT records the fake DNS-over-HTTPS resolver answers with, by name. */
export type FakeDns = Map<string, string[]>;

/** Answers DoH queries from `dns`, then hands everything else to `next` (a fake identity provider, say). */
export function dnsFetch(dns: FakeDns, next?: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      const name = new URL(url).searchParams.get("name") ?? "";
      return Response.json({ Status: 0, Answer: (dns.get(name) ?? []).map((v) => ({ name, type: 16, data: `"${v}"` })) });
    }
    if (next) return next(url, init);
    throw new Error(`unexpected outbound request in a test: ${url}`);
  }) as typeof fetch;
}

/** Adds a domain to the organization, publishes its TXT record in `dns` and verifies it through the API. */
export async function addVerifiedDomain(b: { call: (m: string, p: string, j?: unknown) => Promise<{ status: number; body: any; text: string }> }, orgId: string, domain: string, dns: FakeDns) {
  const add = await b.call("POST", `/v2/organizations/${orgId}/sso/domains`, { domain });
  if (add.status !== 201 && add.status !== 200) throw new Error(`add domain: ${add.status} ${add.text}`);
  dns.set(add.body.txt_record.name, [add.body.txt_record.value]);
  const v = await b.call("POST", `/v2/organizations/${orgId}/sso/domains/${domain}/actions/verify`);
  if (v.status !== 200 || !v.body.verified) throw new Error(`verify domain: ${v.status} ${v.text}`);
  return v.body;
}
