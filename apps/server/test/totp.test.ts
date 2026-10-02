// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: TOTP for two-factor authentication (RFC 6238 test vectors, fixed clocks), base32 and recovery codes.
// Spec: prd/account-settings/PRD.md §3
import { describe, expect, it } from "vitest";
import {
  base32Decode, base32Encode, hotp, looksLikeRecoveryCode, newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUrl, totp, verifyTotp,
} from "../src/services/totp.js";

const ascii = (s: string) => new TextEncoder().encode(s);

describe("RFC 6238 Appendix B test vectors (8 digits)", () => {
  // T in seconds, then the codes for SHA-1, SHA-256 and SHA-512 with the RFC's seeds.
  const vectors: [number, string, string, string][] = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  const sha1 = ascii("12345678901234567890");
  const sha256 = ascii("12345678901234567890123456789012");
  const sha512 = ascii("1234567890123456789012345678901234567890123456789012345678901234");
  for (const [t, a, b, c] of vectors) {
    it(`T = ${t}`, async () => {
      expect(await totp(sha1, t * 1000, { digits: 8 })).toBe(a);
      expect(await totp(sha256, t * 1000, { digits: 8, alg: "SHA-256" })).toBe(b);
      expect(await totp(sha512, t * 1000, { digits: 8, alg: "SHA-512" })).toBe(c);
    });
  }
});

describe("RFC 4226 Appendix D HOTP values (6 digits)", () => {
  it("matches the ten published codes", async () => {
    const want = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    for (let i = 0; i < want.length; i++) expect(await hotp(ascii("12345678901234567890"), i)).toBe(want[i]);
  });
});

describe("verifyTotp", () => {
  const secret = base32Encode(ascii("12345678901234567890")); // GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
  const at = 1_790_917_200_000; // a fixed clock: 2026-10-02T04:20:00Z
  it("accepts the current code and one step of drift either way, nothing further", async () => {
    const key = base32Decode(secret);
    const now = await totp(key, at);
    expect(await verifyTotp(secret, now, at)).toBe(Math.floor(at / 30_000));
    expect(await verifyTotp(secret, await totp(key, at - 30_000), at)).toBe(Math.floor(at / 30_000) - 1);
    expect(await verifyTotp(secret, await totp(key, at + 30_000), at)).toBe(Math.floor(at / 30_000) + 1);
    expect(await verifyTotp(secret, await totp(key, at - 60_000), at)).toBeNull();
    expect(await verifyTotp(secret, await totp(key, at + 60_000), at)).toBeNull();
  });
  it("never accepts a step at or before the last one used (no replay)", async () => {
    const key = base32Decode(secret);
    const code = await totp(key, at);
    const step = Math.floor(at / 30_000);
    expect(await verifyTotp(secret, code, at, step)).toBeNull();
    expect(await verifyTotp(secret, code, at, step - 1)).toBe(step);
    // The previous step's code after the current one was used: refused.
    expect(await verifyTotp(secret, await totp(key, at - 30_000), at, step)).toBeNull();
  });
  it("refuses malformed codes and accepts spaces", async () => {
    const code = await totp(base32Decode(secret), at);
    expect(await verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, at)).not.toBeNull();
    for (const bad of ["", "12345", "1234567", "abcdef", "12345a"]) expect(await verifyTotp(secret, bad, at)).toBeNull();
    expect(await verifyTotp("not base32!", code, at)).toBeNull();
  });
});

describe("base32, secrets and the otpauth URI", () => {
  it("round-trips bytes and reads lower case and padding", () => {
    for (let n = 0; n < 40; n++) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      expect(base32Decode(base32Encode(b))).toEqual(b);
    }
    expect(base32Encode(ascii("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("mzxw6ytboi======")).toEqual(ascii("foobar"));
  });
  it("makes 160-bit secrets and the URI authenticator apps scan", () => {
    const s = newTotpSecret();
    expect(base32Decode(s)).toHaveLength(20);
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl("JBSWY3DPEHPK3PXP", "ana+test@example.com")).toBe("otpauth://totp/RevenueDot:ana%2Btest%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=RevenueDot&algorithm=SHA1&digits=6&period=30");
  });
});

describe("recovery codes", () => {
  it("are 10 distinct xxxxx-xxxxx codes without look-alike characters", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) {
      expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
      expect(c).not.toMatch(/[01ilo]/);
      expect(looksLikeRecoveryCode(c)).toBe(true);
    }
  });
  it("normalise case, spaces and dashes", () => {
    expect(normalizeRecoveryCode("AbCdE FGHJK")).toBe("abcdefghjk");
    expect(normalizeRecoveryCode("abcde-fghjk")).toBe("abcdefghjk");
    expect(looksLikeRecoveryCode("123456")).toBe(false);
  });
});
