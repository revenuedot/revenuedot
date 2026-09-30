import { and, desc, eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";

/** What an SDK request's headers say about the SDK build (see the wire-protocol research, section 12 "Request headers"). */
export interface SdkHeaders {
  platform: string | null;
  platformVersion: string | null;
  platformFlavor: string | null;
  platformFlavorVersion: string | null;
  sdkVersion: string | null;
  appVersion: string | null;
  appBuild: string | null;
  bundleId: string | null;
}

type Headers = { header: (k: string) => string | undefined };
const h = (req: Headers, k: string) => {
  const v = req.header(k)?.trim();
  return v ? v.slice(0, 200) : null;
};

export function sdkHeaders(req: Headers): SdkHeaders {
  return {
    platform: h(req, "x-platform"), platformVersion: h(req, "x-platform-version"), platformFlavor: h(req, "x-platform-flavor"),
    platformFlavorVersion: h(req, "x-platform-flavor-version"), sdkVersion: h(req, "x-version"), appVersion: h(req, "x-client-version"),
    appBuild: h(req, "x-client-build-version"), bundleId: h(req, "x-client-bundle-id"),
  };
}

const THROTTLE_MS = 60_000;
const lastWrite = new WeakMap<DB, Map<string, number>>();

/**
 * Records which SDK build called, per project, app, platform, flavor and version. Written at most once a minute per row
 * and process, so a busy app costs one upsert a minute, not one per request.
 */
export async function recordSdkVersion(db: DB, projectId: string, appId: string | null, s: SdkHeaders, appUserId: string | null, now: Date) {
  if (!s.sdkVersion || !s.platform) return;
  const row = {
    projectId, appId: appId ?? "", platform: s.platform, platformFlavor: s.platformFlavor ?? "native",
    platformFlavorVersion: s.platformFlavorVersion ?? "", sdkVersion: s.sdkVersion,
  };
  const key = Object.values(row).join("\u0000");
  let seen = lastWrite.get(db);
  if (!seen) { seen = new Map(); lastWrite.set(db, seen); }
  const last = seen.get(key);
  if (last !== undefined && Math.abs(now.getTime() - last) < THROTTLE_MS) return;
  seen.set(key, now.getTime());
  const latest = {
    lastPlatformVersion: s.platformVersion, lastAppVersion: s.appVersion, lastAppBuild: s.appBuild, lastBundleId: s.bundleId,
    lastAppUserId: appUserId, lastSeenAt: now,
  };
  const V = schema.sdkVersions;
  await db.insert(V).values({ ...row, ...latest, firstSeenAt: now }).onConflictDoUpdate({
    target: [V.projectId, V.appId, V.platform, V.platformFlavor, V.platformFlavorVersion, V.sdkVersion], set: latest,
  });
}

/**
 * SDK majors whose wire protocol our contract tests cover: the fixtures come from purchases-ios 5.x and purchases-android
 * 9.x/10.x (the versions the hybrid SDKs pin). Hybrid SDKs speak the native protocol, so the native version decides.
 */
const VERIFIED_MAJORS: Record<string, number[]> = { ios: [5], android: [9, 10] };
const family = (platform: string) => (/^(ios|watchos|tvos|macos|uikitformac|visionos)$/i.test(platform) ? "ios" : /^(android|amazon)$/i.test(platform) ? "android" : null);

export function sdkSupport(platform: string, sdkVersion: string): "verified" | "untested" {
  const f = family(platform);
  const major = Number(/^(\d+)\./.exec(sdkVersion)?.[1]);
  return f && VERIFIED_MAJORS[f]!.includes(major) ? "verified" : "untested";
}

/** The `sdk_versions` list of setup health, newest first. */
export async function sdkVersionsOf(db: DB, projectId: string) {
  const V = schema.sdkVersions;
  const rows = await db.select().from(V).where(and(eq(V.projectId, projectId))).orderBy(desc(V.lastSeenAt)).limit(200);
  return rows.map((r) => ({
    app_id: r.appId || null, platform: r.platform, platform_flavor: r.platformFlavor, platform_flavor_version: r.platformFlavorVersion || null,
    sdk_version: r.sdkVersion, support: sdkSupport(r.platform, r.sdkVersion), platform_version: r.lastPlatformVersion, app_version: r.lastAppVersion,
    app_build: r.lastAppBuild, bundle_id: r.lastBundleId, last_app_user_id: r.lastAppUserId,
    first_seen_at: r.firstSeenAt.getTime(), last_seen_at: r.lastSeenAt.getTime(),
  }));
}
