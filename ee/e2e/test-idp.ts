// RevenueDot Enterprise (ee/LICENSE). A local identity provider for browser tests: SAML 2.0 (SP- and IdP-initiated,
// with buttons that send tampered, wrongly signed, wrapped or replayed assertions) and OpenID Connect (discovery,
// authorization page, token endpoint, JWKS). Test only: it signs with the keys in ee/test/fixtures and never runs in
// production. Spec: prd/enterprise/PRD.md §5.
import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { IDP, assertionXml, b64, newId, responseXml, signAssertion } from "../test/saml-idp.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#111}h1{font-size:20px}label{display:block;margin:12px 0 4px;font-weight:600}input[type=text],input[type=email]{width:100%;padding:8px;border:1px solid #ccc;box-sizing:border-box}fieldset{border:1px solid #ddd;margin:16px 0;padding:8px 12px}fieldset label{font-weight:400;margin:4px 0}button{margin-top:16px;padding:10px 16px;background:#111;color:#fff;border:0;cursor:pointer}.note{color:#666;font-size:12px}</style>
</head><body><p class="note">Test identity provider (development only)</p>${body}</body></html>`;

export interface TestIdpOptions { origin: string }

/** The last SAML Response posted, per ACS URL, for the "replay" button. */
const lastResponse = new Map<string, string>();

export async function testIdp(o: TestIdpOptions) {
  const app = new Hono();
  const samlEntity = `${o.origin}/saml/metadata`;
  const certBody = IDP.cert.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");

  // ---- SAML ----
  app.get("/saml/metadata", (c) => c.body(`<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${samlEntity}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" WantAuthnRequestsSigned="false">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certBody}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${o.origin}/saml/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`, 200, { "content-type": "application/samlmetadata+xml" }));

  const form = (fields: Record<string, string>, note: string) => page("Sign in", `<h1>Sign in to the test identity provider</h1><p>${note}</p>
<form method="post" action="/saml/respond">
${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}
<label for="email">Email</label><input id="email" name="email" type="email" value="${esc(fields.login_hint ?? "")}" required>
<label for="first">First name</label><input id="first" name="first" type="text" value="Ada">
<label for="last">Last name</label><input id="last" name="last" type="text" value="Admin">
<label for="groups">Groups (comma separated)</label><input id="groups" name="groups" type="text" value="">
<fieldset><legend>Response</legend>
<label><input type="radio" name="mode" value="valid" checked> Valid, signed assertion</label>
<label><input type="radio" name="mode" value="tamper"> Change the email after signing</label>
<label><input type="radio" name="mode" value="attacker"> Signed with an unknown key</label>
<label><input type="radio" name="mode" value="unsigned"> Unsigned assertion</label>
<label><input type="radio" name="mode" value="wrap"> Signature wrapping (evil assertion first)</label>
<label><input type="radio" name="mode" value="expired"> Expired assertion</label>
<label><input type="radio" name="mode" value="audience"> Wrong audience</label>
<label><input type="radio" name="mode" value="replay"> Replay the previous response</label>
</fieldset>
<button type="submit">Sign in</button></form>`);

  app.get("/saml/sso", async (c) => {
    const req = c.req.query("SAMLRequest");
    if (!req) return c.html(page("Error", "<p>Missing SAMLRequest.</p>"), 400);
    const { inflateRawSync } = await import("node:zlib");
    const xml = inflateRawSync(Buffer.from(req, "base64")).toString("utf8");
    const id = /\bID="([^"]+)"/.exec(xml)?.[1] ?? "";
    const acs = /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)?.[1] ?? "";
    const audience = /<(?:saml2?:)?Issuer[^>]*>([^<]+)</.exec(xml)?.[1] ?? "";
    return c.html(form({ in_response_to: id, acs, audience, relay_state: c.req.query("RelayState") ?? "" }, `RevenueDot asked to sign you in (request <code>${esc(id)}</code>).`));
  });

  // IdP-initiated: the person starts here (like an Okta or Entra dashboard tile), with no request from RevenueDot.
  app.get("/saml/idp-initiated", (c) => {
    const acs = c.req.query("acs") ?? "", audience = c.req.query("audience") ?? acs.replace(/\/acs$/, "/metadata");
    return c.html(form({ in_response_to: "", acs, audience, relay_state: c.req.query("next") ?? "" }, `Sign in to RevenueDot from the identity provider (no request from RevenueDot).`));
  });

  app.post("/saml/respond", async (c) => {
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    const acs = f.acs ?? "", email = (f.email ?? "").trim();
    const groups = (f.groups ?? "").split(",").map((g) => g.trim()).filter(Boolean);
    const attributes: Record<string, string[]> = { firstName: [f.first ?? ""], lastName: [f.last ?? ""], ...(groups.length ? { groups } : {}) };
    const base = { acsUrl: acs, audience: f.audience ?? "", email, issuer: samlEntity, inResponseTo: f.in_response_to || null, attributes };
    let xml: string;
    const mode = f.mode ?? "valid";
    if (mode === "replay" && lastResponse.get(acs)) xml = lastResponse.get(acs)!;
    else {
      let inner: string;
      if (mode === "tamper") inner = signAssertion(assertionXml(base)).replace(new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), `mallory@${email.split("@")[1] ?? "example.test"}`);
      else if (mode === "attacker") inner = signAssertion(assertionXml(base), IDP.attackerKey, IDP.attackerCert);
      else if (mode === "unsigned") inner = assertionXml(base);
      else if (mode === "wrap") inner = assertionXml({ ...base, email: `mallory@${email.split("@")[1] ?? "example.test"}`, assertionId: newId() }) + signAssertion(assertionXml(base));
      else if (mode === "expired") inner = signAssertion(assertionXml({ ...base, notBefore: new Date(Date.now() - 3_600_000), notOnOrAfter: new Date(Date.now() - 600_000) }));
      else if (mode === "audience") inner = signAssertion(assertionXml({ ...base, audience: "https://someone-else.example/sp" }));
      else inner = signAssertion(assertionXml(base));
      xml = b64(responseXml(inner, { destination: acs, inResponseTo: f.in_response_to || null, issuer: samlEntity }));
      if (mode === "valid") lastResponse.set(acs, xml);
    }
    return c.html(page("Signing in…", `<p>Sending you back to RevenueDot…</p><form id="f" method="post" action="${esc(acs)}"><input type="hidden" name="SAMLResponse" value="${esc(xml)}">${f.relay_state ? `<input type="hidden" name="RelayState" value="${esc(f.relay_state)}">` : ""}<button type="submit">Continue</button></form><script>document.getElementById("f").submit()</script>`));
  });

  // ---- OpenID Connect ----
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-1", alg: "RS256", use: "sig" };
  const issuer = `${o.origin}/oidc`;
  const codes = new Map<string, { clientId: string; redirectUri: string; nonce: string; challenge: string; email: string; groups: string[]; verified: boolean; badNonce: boolean }>();
  app.get("/oidc/.well-known/openid-configuration", (c) => c.json({
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"], code_challenge_methods_supported: ["S256"], scopes_supported: ["openid", "email", "profile", "groups"],
  }));
  app.get("/oidc/jwks", (c) => c.json({ keys: [jwk] }));
  app.get("/oidc/authorize", (c) => {
    const q = c.req.query();
    return c.html(page("Sign in", `<h1>Sign in with OpenID Connect (test)</h1><p>Client <code>${esc(q.client_id ?? "")}</code></p>
<form method="post" action="/oidc/authorize">${["client_id", "redirect_uri", "state", "nonce", "code_challenge"].map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] ?? "")}">`).join("")}
<label for="email">Email</label><input id="email" name="email" type="email" value="${esc(q.login_hint ?? "")}" required>
<label for="groups">Groups (comma separated)</label><input id="groups" name="groups" type="text" value="">
<fieldset><legend>Response</legend>
<label><input type="radio" name="mode" value="valid" checked> Valid ID token</label>
<label><input type="radio" name="mode" value="unverified"> email_verified is false</label>
<label><input type="radio" name="mode" value="nonce"> Wrong nonce</label>
</fieldset><button type="submit">Sign in</button></form>`));
  });
  app.post("/oidc/authorize", async (c) => {
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    const code = randomBytes(16).toString("hex");
    codes.set(code, { clientId: f.client_id ?? "", redirectUri: f.redirect_uri ?? "", nonce: f.nonce ?? "", challenge: f.code_challenge ?? "", email: (f.email ?? "").trim(), groups: (f.groups ?? "").split(",").map((g) => g.trim()).filter(Boolean), verified: f.mode !== "unverified", badNonce: f.mode === "nonce" });
    const back = new URL(f.redirect_uri ?? "");
    back.searchParams.set("code", code);
    back.searchParams.set("state", f.state ?? "");
    return c.redirect(back.toString(), 302);
  });
  app.post("/oidc/token", async (c) => {
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    const entry = codes.get(f.code ?? "");
    codes.delete(f.code ?? "");
    if (!entry) return c.json({ error: "invalid_grant" }, 400);
    const auth = c.req.header("authorization");
    const clientId = auth?.startsWith("Basic ") ? decodeURIComponent(atob(auth.slice(6)).split(":")[0]!) : f.client_id;
    if (clientId !== entry.clientId) return c.json({ error: "invalid_client" }, 401);
    const challenge = createHash("sha256").update(f.code_verifier ?? "").digest("base64url");
    if (challenge !== entry.challenge) return c.json({ error: "invalid_grant", error_description: "PKCE verifier does not match" }, 400);
    const idToken = await new SignJWT({ email: entry.email, email_verified: entry.verified, name: entry.email.split("@")[0], nonce: entry.badNonce ? "not-the-nonce" : entry.nonce, groups: entry.groups })
      .setProtectedHeader({ alg: "RS256", kid: "test-1" }).setIssuer(issuer).setAudience(entry.clientId).setSubject(`sub-${entry.email}`).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    return c.json({ access_token: randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 300, id_token: idToken });
  });

  app.get("/", (c) => c.html(page("Test identity provider", `<h1>Test identity provider</h1><ul><li>SAML metadata: <a href="/saml/metadata">${esc(`${o.origin}/saml/metadata`)}</a></li><li>OpenID Connect issuer: <code>${esc(issuer)}</code></li></ul>`)));
  return { app, samlEntity, issuer };
}
