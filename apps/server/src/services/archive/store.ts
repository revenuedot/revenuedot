import { eq, like } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { fromBase64, toBase64 } from "../signing.js";
import { encodePath, sha256Hex, signV4 } from "../exports/sigv4.js";

/**
 * Where archive files live (prd/moves-export/PRD.md): R2 through the Worker's `EXPORTS` binding on Cloud, the local disk
 * (archive/disk-store.ts, Node only) or an S3-compatible bucket on self-host, and Postgres when nothing else is set.
 * Keys look like `exports/<project>/<export id>/tables/customers/0001.jsonl.gz`.
 */
export interface ArchiveStore {
  kind: "r2" | "disk" | "s3" | "db";
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  deletePrefix(prefix: string): Promise<void>;
}

/** Postgres (`archive_blobs`). Fine for small and medium projects; set a bucket or a folder for big ones. */
export function dbStore(db: DB): ArchiveStore {
  const B = schema.archiveBlobs;
  return {
    kind: "db",
    async put(key, bytes) {
      const dataBase64 = toBase64(bytes);
      await db.insert(B).values({ key, dataBase64, size: bytes.length }).onConflictDoUpdate({ target: B.key, set: { dataBase64, size: bytes.length } });
    },
    async get(key) {
      const [r] = await db.select({ d: B.dataBase64 }).from(B).where(eq(B.key, key)).limit(1);
      return r ? fromBase64(r.d) : null;
    },
    async deletePrefix(prefix) { await db.delete(B).where(like(B.key, `${prefix.replace(/[%_\\]/g, "\\$&")}%`)); },
  };
}

/** The Workers R2 binding, typed only as far as it is used. */
export interface R2BucketLike {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  list(o: { prefix: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<void>;
}

export function r2Store(bucket: R2BucketLike): ArchiveStore {
  return {
    kind: "r2",
    async put(key, bytes) { await bucket.put(key, bytes); },
    async get(key) { const o = await bucket.get(key); return o ? new Uint8Array(await o.arrayBuffer()) : null; },
    async deletePrefix(prefix) {
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor });
        if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    },
  };
}

export interface S3ArchiveConfig { bucket: string; region?: string; endpoint?: string; accessKeyId: string; secretAccessKey: string; prefix?: string }

/** Any S3-compatible bucket (AWS S3, R2's S3 API, MinIO), path-style when an endpoint is given. */
export function s3Store(c: S3ArchiveConfig, f: typeof fetch = fetch, now: () => Date = () => new Date()): ArchiveStore {
  const region = c.region || (c.endpoint?.includes("r2.cloudflarestorage.com") ? "auto" : "us-east-1");
  const base = c.endpoint ? `${c.endpoint.replace(/\/+$/, "")}/${c.bucket}` : `https://${c.bucket}.s3.${region}.amazonaws.com`;
  const full = (key: string) => `${c.prefix ? `${c.prefix.replace(/^\/+|\/+$/g, "")}/` : ""}${key}`;
  const send = async (method: string, key: string, body?: Uint8Array) => {
    const url = `${base}/${encodePath(full(key))}`;
    const signed = await signV4({ method, url, payloadHash: await sha256Hex(body ?? ""), accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region, service: "s3", now: now(), contentSha256Header: true });
    return f(url, { method, headers: signed.headers, body: body as Uint8Array<ArrayBuffer> | undefined });
  };
  return {
    kind: "s3",
    async put(key, bytes) {
      const r = await send("PUT", key, bytes);
      if (!r.ok) throw new Error(`Archive bucket answered HTTP ${r.status} to an upload.`);
    },
    async get(key) {
      const r = await send("GET", key);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Archive bucket answered HTTP ${r.status} to a download.`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async deletePrefix(prefix) {
      // ListObjectsV2, then one DELETE per object (no batch delete: it needs Content-MD5, which WebCrypto lacks).
      let token: string | null = null;
      do {
        const q: URLSearchParams = new URLSearchParams({ "list-type": "2", prefix: full(prefix), ...(token ? { "continuation-token": token } : {}) });
        const qs: string = [...q.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
        const url: string = `${base}/?${qs}`;
        const signed = await signV4({ method: "GET", url, payloadHash: await sha256Hex(""), accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region, service: "s3", now: now(), contentSha256Header: true });
        const r: Response = await f(url, { headers: signed.headers });
        if (!r.ok) return;
        const xml: string = await r.text();
        const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
        const strip = c.prefix ? `${c.prefix.replace(/^\/+|\/+$/g, "")}/` : "";
        for (const k of keys) await send("DELETE", k.startsWith(strip) ? k.slice(strip.length) : k);
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)</.exec(xml)?.[1] ?? null : null;
      } while (token);
    },
  };
}

/** Self-host bucket settings from the environment (REVENUEDOT_ARCHIVE_S3_BUCKET …), or null. */
export function s3ConfigFromEnv(env: Record<string, string | undefined>): S3ArchiveConfig | null {
  const bucket = env.REVENUEDOT_ARCHIVE_S3_BUCKET?.trim();
  if (!bucket) return null;
  return {
    bucket, region: env.REVENUEDOT_ARCHIVE_S3_REGION?.trim() || undefined, endpoint: env.REVENUEDOT_ARCHIVE_S3_ENDPOINT?.trim() || undefined,
    accessKeyId: env.REVENUEDOT_ARCHIVE_S3_ACCESS_KEY_ID?.trim() ?? "", secretAccessKey: env.REVENUEDOT_ARCHIVE_S3_SECRET_ACCESS_KEY?.trim() ?? "",
    prefix: env.REVENUEDOT_ARCHIVE_S3_PREFIX?.trim() || undefined,
  };
}
