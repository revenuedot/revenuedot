/**
 * Cloudflare for SaaS custom hostnames (https://developers.cloudflare.com/api/resources/custom_hostnames/): the TLS
 * certificate for a customer's domain on RevenueDot Cloud. Used only when Deps.cloudflareSaas is set; otherwise adding the
 * hostname is a manual step (docs/cloud.md, "Hosted web pages and custom domains").
 */
const API = "https://api.cloudflare.com/client/v4";

export interface CustomHostname { id: string; hostname: string; status: string; sslStatus: string | null; error: string | null }

export class CloudflareSaasError extends Error { constructor(message: string, readonly status = 0) { super(message); } }

interface CfHostname { id: string; hostname: string; status?: string; ssl?: { status?: string; validation_errors?: { message?: string }[] } | null; verification_errors?: string[] }

async function call<T>(fetchFn: typeof fetch, cfg: { zoneId: string; apiToken: string }, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(`${API}/zones/${encodeURIComponent(cfg.zoneId)}/custom_hostnames${path}`, {
      method, headers: { authorization: `Bearer ${cfg.apiToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new CloudflareSaasError(`Cloudflare could not be reached: ${e instanceof Error ? e.message : String(e)}`);
  }
  const j = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { message?: string }[] } | null;
  if (!res.ok || !j?.success) throw new CloudflareSaasError(`Cloudflare answered ${res.status}: ${j?.errors?.map((e) => e.message).filter(Boolean).join("; ") || "no details"}`, res.status);
  return j.result as T;
}

const shape = (h: CfHostname): CustomHostname => ({
  id: h.id, hostname: h.hostname, status: h.status ?? "pending", sslStatus: h.ssl?.status ?? null,
  error: h.ssl?.validation_errors?.map((e) => e.message).filter(Boolean).join("; ") || h.verification_errors?.join("; ") || null,
});

/** Adds the hostname with a DV certificate validated over HTTP (the CNAME to the fallback origin proves it), or finds it. */
export async function ensureCustomHostname(fetchFn: typeof fetch, cfg: { zoneId: string; apiToken: string }, hostname: string): Promise<CustomHostname> {
  const found = await call<CfHostname[]>(fetchFn, cfg, "GET", `?hostname=${encodeURIComponent(hostname)}`);
  const same = found.find((h) => h.hostname === hostname);
  if (same) return shape(same);
  return shape(await call<CfHostname>(fetchFn, cfg, "POST", "", { hostname, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } }));
}

export async function getCustomHostname(fetchFn: typeof fetch, cfg: { zoneId: string; apiToken: string }, id: string): Promise<CustomHostname> {
  return shape(await call<CfHostname>(fetchFn, cfg, "GET", `/${encodeURIComponent(id)}`));
}

export async function deleteCustomHostname(fetchFn: typeof fetch, cfg: { zoneId: string; apiToken: string }, id: string): Promise<void> {
  await call<unknown>(fetchFn, cfg, "DELETE", `/${encodeURIComponent(id)}`);
}
