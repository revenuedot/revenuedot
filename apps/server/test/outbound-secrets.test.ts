import { describe, expect, it } from "vitest";
import { outboundUrlProblem } from "../src/services/outbound.js";
import { seal, secretKeyFrom, unseal } from "../src/services/secrets.js";
import { clearGoogleTokens, googleAccessToken, type ServiceAccountKey } from "../src/services/google-sa.js";
import { makeKeys } from "./google-helpers.js";
import { GooglePlayClient, type ServiceAccount } from "../src/stores/google/api.js";

/** The outbound URL guard, the sealing key ring and the Google token cache: the defences around customer-set URLs and keys. */

describe("outbound URL guard", () => {
  it("always refuses metadata, link-local and odd schemes; Cloud also refuses private networks", () => {
    for (const u of ["http://169.254.169.254/latest/meta-data", "http://[fe80::1]/", "http://[::ffff:169.254.169.254]/", "http://metadata.google.internal/", "http://0.0.0.0:5432/", "file:///etc/passwd", "https://user:pw@hooks.example.com/"]) {
      expect(outboundUrlProblem(u, false), u).not.toBeNull();
    }
    for (const u of ["http://127.0.0.1:8080/slack", "http://10.0.0.5/", "http://2130706433/", "http://[::1]/", "http://localhost:9000/", "http://posthog.internal/", "http://minio:9000/", "http://example.com/"]) {
      expect(outboundUrlProblem(u, true), u).not.toBeNull();
      if (!u.startsWith("http://example")) expect(outboundUrlProblem(u, false), u).toBeNull();
    }
    expect(outboundUrlProblem("https://hooks.slack.com/services/T/B/x", true)).toBeNull();
    expect(outboundUrlProblem("https://acme.r2.cloudflarestorage.com/bucket/key", true)).toBeNull();
  });
});

describe("sealing keys", () => {
  const ENC = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
  const SIGN = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));

  it("adding REVENUEDOT_ENCRYPTION_KEY later keeps secrets sealed with the signing-derived key readable", async () => {
    const derived = await secretKeyFrom(undefined, SIGN);
    const sealed = await seal({ api_key: "k-123" }, derived);
    const both = await secretKeyFrom(ENC, SIGN);
    expect(both!.id).not.toBe(derived!.id);
    expect(await unseal(sealed, both)).toEqual({ api_key: "k-123" });
    // New writes use the dedicated key, which the derived key alone cannot open.
    const resealed = await seal({ api_key: "k-123" }, both);
    expect(resealed!.split(":")[1]).toBe(both!.id);
    await expect(unseal(resealed, derived)).rejects.toThrow(/different key/);
  });

  it("a malformed key is reported every time, not cached as a broken promise", async () => {
    await expect(secretKeyFrom("dG9vIHNob3J0", null)).rejects.toThrow(/32 random bytes/);
    await expect(secretKeyFrom("dG9vIHNob3J0", null)).rejects.toThrow(/32 random bytes/);
  });
});

describe("Google service-account tokens", () => {
  it("ignore the key file's token_uri and are cached per private key, not per client_email", async () => {
    const sa = (await makeKeys()).sa as unknown as ServiceAccountKey;
    const otherKey = ((await makeKeys()).sa as unknown as ServiceAccountKey).private_key;
    clearGoogleTokens();
    const urls: string[] = [];
    let n = 0;
    const f = (async (url: string) => { urls.push(String(url)); n++; return Response.json({ access_token: `tok-${n}`, expires_in: 3600 }); }) as unknown as typeof fetch;
    const now = Date.now();
    const a = await googleAccessToken({ ...sa, token_uri: "http://169.254.169.254/token" }, "scope", f, now);
    // Same client_email and key id, a different private key: must not get the first key's token.
    const b = await googleAccessToken({ ...sa, private_key: otherKey }, "scope", f, now);
    const c = await googleAccessToken(sa, "scope", f, now);
    expect([a, b, c]).toEqual(["tok-1", "tok-2", "tok-1"]);
    expect(urls).toEqual(["https://oauth2.googleapis.com/token", "https://oauth2.googleapis.com/token"]);
  });
});

describe("Google Play client tokens", () => {
  it("go to Google's token endpoint whatever the key file's token_uri says, and are cached per private key", async () => {
    const sa = (await makeKeys()).sa as unknown as ServiceAccount;
    const otherKey = ((await makeKeys()).sa as unknown as ServiceAccount).private_key;
    const urls: string[] = [];
    let n = 0;
    const client = new GooglePlayClient({ fetch: (async (url: string) => { urls.push(String(url)); n++; return Response.json({ access_token: `tok-${n}`, expires_in: 3600 }); }) as unknown as typeof fetch });
    const a = await client.accessToken({ ...sa, token_uri: "http://169.254.169.254/token" });
    // Same client_email and private_key_id (neither is secret), another private key: must not get the first key's token.
    const b = await client.accessToken({ ...sa, private_key: otherKey });
    const c = await client.accessToken(sa);
    expect([a, b, c]).toEqual(["tok-1", "tok-2", "tok-1"]);
    expect(urls).toEqual(["https://oauth2.googleapis.com/token", "https://oauth2.googleapis.com/token"]);
  });
});
