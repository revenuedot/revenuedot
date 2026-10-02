import { describe, expect, it } from "vitest";
import { requestOrigin } from "../src/services/account-email.js";

const h = (m: Record<string, string>) => (n: string) => m[n];

describe("requestOrigin", () => {
  it("keeps the request's scheme when a proxy sends only X-Forwarded-Host", () => {
    expect(requestOrigin("http://localhost:5615/v1/x", h({ "x-forwarded-host": "localhost:5615" }))).toBe("http://localhost:5615");
  });
  it("uses X-Forwarded-Proto and the first forwarded host behind a TLS proxy", () => {
    expect(requestOrigin("http://10.0.0.2/v1/x", h({ "x-forwarded-host": "api.example.com", "x-forwarded-proto": "https" }))).toBe("https://api.example.com");
    expect(requestOrigin("http://10.0.0.2/v1/x", h({ "x-forwarded-host": "a.example.com, b", "x-forwarded-proto": "javascript" }))).toBe("https://a.example.com");
  });
  it("uses the request's own origin without proxy headers", () => {
    expect(requestOrigin("https://api.example.com/v1/x", h({}))).toBe("https://api.example.com");
  });
});
