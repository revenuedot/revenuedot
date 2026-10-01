import { describe, expect, it } from "vitest";
import { API_PATH } from "../src/api-paths.js";

describe("paths the Cloud Worker answers on the dashboard host", () => {
  it("includes the OAuth pages and endpoints, so ChatGPT and Claude land on the consent page and not the dashboard", () => {
    for (const p of ["/oauth/authorize", "/oauth/token", "/oauth/register", "/.well-known/oauth-authorization-server", "/auth/login", "/v2/projects", "/v1/subscribers/x"]) {
      expect(API_PATH.test(p), p).toBe(true);
    }
  });
  it("leaves dashboard routes to the dashboard", () => {
    for (const p of ["/", "/login", "/projects/projabc/overview", "/oauthfoo", "/account", "/verify-email"]) {
      expect(API_PATH.test(p), p).toBe(false);
    }
  });
});
