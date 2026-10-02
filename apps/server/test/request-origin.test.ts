import { describe, expect, it } from "vitest";
import { requestOrigin } from "../src/services/account-email.js";

const h = (m: Record<string, string>) => (n: string) => m[n];

describe("requestOrigin", () => {
  it("keeps http for a loopback host when a local proxy sends only X-Forwarded-Host", () => {
    expect(requestOrigin("http://localhost:5615/v1/x", h({ "x-forwarded-host": "localhost:5615" }))).toBe("http://localhost:5615");
    expect(requestOrigin("http://127.0.0.1:5615/v1/x", h({ "x-forwarded-host": "127.0.0.1:5615" }))).toBe("http://127.0.0.1:5615");
    expect(requestOrigin("http://app.localhost:5615/v1/x", h({ "x-forwarded-host": "app.localhost:5615" }))).toBe("http://app.localhost:5615");
  });
  it("assumes a TLS proxy when a public host comes without X-Forwarded-Proto", () => {
    expect(requestOrigin("http://10.0.0.2:8787/v1/x", h({ "x-forwarded-host": "api.example.com" }))).toBe("https://api.example.com");
    expect(requestOrigin("http://10.0.0.2:8787/v1/x", h({ "x-forwarded-host": "localhost.example.com" }))).toBe("https://localhost.example.com");
  });
  it("uses X-Forwarded-Proto and the first forwarded host behind a proxy", () => {
    expect(requestOrigin("http://10.0.0.2/v1/x", h({ "x-forwarded-host": "api.example.com", "x-forwarded-proto": "https" }))).toBe("https://api.example.com");
    expect(requestOrigin("http://10.0.0.2/v1/x", h({ "x-forwarded-host": "lan.example", "x-forwarded-proto": "HTTP" }))).toBe("http://lan.example");
    expect(requestOrigin("http://10.0.0.2/v1/x", h({ "x-forwarded-host": "a.example.com, b", "x-forwarded-proto": "javascript" }))).toBe("https://a.example.com");
  });
  it("uses the request's own origin without proxy headers", () => {
    expect(requestOrigin("https://api.example.com/v1/x", h({}))).toBe("https://api.example.com");
    expect(requestOrigin("http://localhost:8787/v1/x", h({ "x-forwarded-host": "" }))).toBe("http://localhost:8787");
  });
});
