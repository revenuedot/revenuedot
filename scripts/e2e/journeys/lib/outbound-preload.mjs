// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: a Node preload for the journey server (`node --import`). It plays the part of DNS for the server's outbound
// calls, so the real delivery code (store adapters, integrations, exports, the outbound guard) runs unchanged while the
// network answers come from this machine:
//   RD_JOURNEY_ROUTES   JSON { "<host>": "<base url>" }: calls to <host> go to <base url> + the original path and query,
//                       with the original host in the `x-rd-original-host` header. "*" is the default for every host not
//                       listed and not allowed.
//   RD_JOURNEY_ALLOW    comma-separated hosts that may be called for real (public, read-only or validation endpoints).
//   RD_JOURNEY_BLOCK    comma-separated host suffixes that are never called (Apple, Google Play): 503 instead.
//   RD_JOURNEY_FAKED    comma-separated hosts routed to the capture server even under a blocked suffix.
//   RD_JOURNEY_OUTBOUND_LOG  file: one JSON line per outbound call (method, host, path, routed to, status); no headers,
//                       and bodies only for Google Analytics validation hits (which carry no secret).
// Google Analytics: Measurement Protocol hits (`/mp/collect`) go to Google's validation server (`/debug/mp/collect`), which
// checks the payload and records nothing; its validation messages are written to the outbound log as `validation`.
// Only globalThis.fetch is wrapped; local addresses pass through untouched.
import { appendFileSync } from "node:fs";

const routes = JSON.parse(process.env.RD_JOURNEY_ROUTES || "{}");
const allow = new Set((process.env.RD_JOURNEY_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean));
const block = (process.env.RD_JOURNEY_BLOCK || "").split(",").map((s) => s.trim()).filter(Boolean);
// Hosts answered by fakes on the capture server even when a blocked suffix covers them (Apple's public AdServices API).
const faked = new Set((process.env.RD_JOURNEY_FAKED || "").split(",").map((s) => s.trim()).filter(Boolean));
const log = process.env.RD_JOURNEY_OUTBOUND_LOG;
const realFetch = globalThis.fetch;
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function record(entry) {
  if (log) try { appendFileSync(log, JSON.stringify({ at: Date.now(), ...entry }) + "\n"); } catch { /* best effort */ }
}

globalThis.fetch = async function journeyFetch(input, init) {
  const req = input instanceof Request ? input : null;
  const url = new URL(req ? req.url : input instanceof URL ? input.href : String(input));
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const host = url.hostname.toLowerCase();
  if (LOCAL.has(host)) return realFetch(input, init);
  if (!faked.has(host) && block.some((b) => host === b || host.endsWith(`.${b}`))) {
    record({ method, host, path: url.pathname, routed: "blocked", status: 503 });
    return new Response(JSON.stringify({ error: `journey run: ${host} is never called` }), { status: 503, headers: { "content-type": "application/json" } });
  }
  if (allow.has(host) && /(^|\.)google-analytics\.com$/.test(host) && url.pathname === "/mp/collect") {
    const debugUrl = new URL(url.href);
    debugUrl.pathname = "/debug/mp/collect";
    let body = init?.body;
    if (body === undefined && req) body = await req.text();
    const res = await realFetch(debugUrl, { method, headers: init?.headers ?? req?.headers, body });
    const text = await res.text();
    let validation = null;
    try { validation = JSON.parse(text); } catch { validation = text.slice(0, 500); }
    // Which stream: Firebase app streams send firebase_app_id, web streams measurement_id (ids only, never the api_secret).
    const stream = url.searchParams.get("firebase_app_id") ?? url.searchParams.get("measurement_id");
    record({ method, host, path: url.pathname, routed: "real-debug", status: res.status, stream, validation, body: typeof body === "string" ? body.slice(0, 4000) : null });
    // The delivery code sees the answer the real /mp/collect gives (204, empty).
    return new Response(null, { status: res.ok ? 204 : res.status });
  }
  if (allow.has(host)) {
    const res = await realFetch(input, init);
    record({ method, host, path: url.pathname, routed: "real", status: res.status });
    return res;
  }
  const base = routes[host] ?? routes["*"];
  if (!base) {
    record({ method, host, path: url.pathname, routed: "refused", status: 503 });
    return new Response(JSON.stringify({ error: `journey run: no route for ${host}` }), { status: 503, headers: { "content-type": "application/json" } });
  }
  const target = new URL(base.replace(/\/$/, "") + url.pathname + url.search);
  const headers = new Headers(init?.headers ?? req?.headers);
  headers.set("x-rd-original-host", host);
  headers.set("x-rd-original-url", url.href);
  let body = init?.body;
  if (body === undefined && req && method !== "GET" && method !== "HEAD") body = await req.arrayBuffer();
  const res = await realFetch(target, { method, headers, body, redirect: init?.redirect ?? "follow", signal: init?.signal, ...(body && typeof body === "object" && "getReader" in body ? { duplex: "half" } : {}) });
  record({ method, host, path: url.pathname, routed: target.origin, status: res.status });
  return res;
};
