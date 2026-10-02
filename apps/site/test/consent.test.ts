import { describe, expect, it } from "vitest";
import { applyConsent, needsCookieless } from "../worker/consent";

describe("needsCookieless", () => {
  it("is true for the EU, EEA, UK and Switzerland, and false elsewhere or when the country is unknown", () => {
    for (const c of ["DE", "FR", "IE", "SE", "NO", "IS", "LI", "GB", "CH", "gb"]) expect(needsCookieless(c), c).toBe(true);
    for (const c of ["US", "CA", "IN", "AU", "BR", "JP", "SG", "XX"]) expect(needsCookieless(c), c).toBe(false);
    expect(needsCookieless(undefined)).toBe(false);
    expect(needsCookieless(null)).toBe(false);
  });
});

describe("applyConsent", () => {
  const page = () => new Response('<script data-website-id="dfid_x" src="https://datafa.st/js/script.js"></script>', { headers: { "content-type": "text/html; charset=utf-8" } });
  const req = (country?: string) => Object.assign(new Request("https://revenuedot.app/"), { cf: { country } });
  it("leaves the response alone outside Europe, for non-HTML, and without HTMLRewriter (as in Node)", async () => {
    const us = page();
    expect(applyConsent(req("US"), us)).toBe(us);
    const json = new Response("{}", { headers: { "content-type": "application/json" } });
    expect(applyConsent(req("DE"), json)).toBe(json);
    const de = page();
    expect(applyConsent(req("DE"), de)).toBe(de);
  });
  it("swaps the script for the cookieless one in Europe", async () => {
    class FakeRewriter {
      handlers: any[] = [];
      on(_sel: string, h: any) { this.handlers.push(h); return this; }
      transform(r: Response) {
        const h = this.handlers[0]; const attrs: Record<string, string> = { src: "https://datafa.st/js/script.js" };
        h.element({ getAttribute: (n: string) => attrs[n] ?? null, setAttribute: (n: string, v: string) => { attrs[n] = v; } });
        return new Response(`<script src="${attrs.src}"></script>`, r);
      }
    }
    (globalThis as any).HTMLRewriter = FakeRewriter;
    try {
      const out = applyConsent(req("FR"), page());
      expect(await out.text()).toBe('<script src="https://datafa.st/js/script.cookieless.js"></script>');
    } finally { delete (globalThis as any).HTMLRewriter; }
  });
});
