import { useQuery } from "@tanstack/react-query";
import { api, type List } from "../../lib/api";

/** API shapes and queries shared by the setup pages (apps, API keys, integrations, project settings). */

export type AppType = "app_store" | "mac_app_store" | "play_store" | "amazon" | "stripe" | "rc_billing" | "roku" | "paddle" | "test_store" | "galaxy";

export interface App {
  object: "app"; id: string; name: string; type: AppType; project_id: string; created_at: number; custom_url_scheme?: string;
  app_store?: { bundle_id: string; subscription_key_configured: boolean; app_store_connect_api_key_configured: boolean; app_store_connect_vendor_number: string | null };
  mac_app_store?: { bundle_id: string };
  play_store?: { package_name: string; play_service_account_credentials_configured: boolean };
  amazon?: { package_name: string };
  stripe?: { stripe_account_id: string | null };
  paddle?: { paddle_is_sandbox: boolean; paddle_api_key: null };
  roku?: { roku_channel_id: string | null; roku_channel_name: string | null };
  galaxy?: { package_name: string };
}

export interface PublicKey { object: "public_api_key"; id: string; key: string; environment: "production" | "sandbox"; app_id: string; created_at: number }

export interface StoreSettings {
  object: "app_store_settings"; app_id: string; type: AppType; api_origin: string;
  notification_url: string | null; notification_forward_url: string | null;
  /** "Test your setup with the sample app": examples that can buy with this app (GET …/sample_app?platform=). */
  sample_apps?: Array<{ platform: string; name: string; example: string }>;
  last_notification_at: number | null; last_notification_error: string | null;
  /** Unsigned or badly signed requests of the last 24 hours; they never change the notification status. */
  rejected_requests?: RejectedRequests;
  last_forward: { status: number; at: number } | null;
  track_new_purchases: boolean; allow_unsigned_receipts: boolean;
  credentials: {
    subscription_key: { configured: boolean; key_id: string | null; issuer_id: string | null };
    app_store_connect_api_key: { configured: boolean; key_id: string | null; issuer_id: string | null; vendor_number: string | null };
    shared_secret: { configured: boolean };
    play_service_account: { configured: boolean; client_email: string | null };
    xcode_certificate: { configured: boolean };
    amazon_shared_secret?: { configured: boolean };
    stripe_secret_key?: { configured: boolean; mode: "live" | "test" | null; kind: "restricted" | "secret" | "other" | null; last4: string | null };
    stripe_webhook_secret?: { configured: boolean };
    paddle_api_key?: { configured: boolean; environment: "live" | "sandbox" | null; last4: string | null };
    paddle_webhook_secret?: { configured: boolean };
    roku_api_key?: { configured: boolean };
    galaxy_service_account?: { configured: boolean; service_account_id: string | null };
    galaxy_iap_public_key?: { configured: boolean };
  };
  /** Amazon: the SNS topic notifications must come from (optional). */
  sns_topic_arn?: string | null;
  /** Stripe: how purchases first seen in a webhook find their customer, and when a subscription counts. */
  stripe?: {
    stripe_account_id: string | null; app_user_id_source: "metadata" | "customer_id" | "anonymous"; app_user_id_metadata_key: string; register_on: "invoice_paid" | "invoice_created"; configured: boolean;
    /** How the app reaches Stripe: "Connect with Stripe", a restricted key, or not yet. */
    connection?: "stripe_connect" | "restricted_key" | null; connected_account?: string | null; mode?: "live" | "test" | null;
  } | null;
  /** Paddle: the key's environment, how purchases first seen in a notification find their customer, Apply in Paddle's destination. */
  paddle?: { environment: "live" | "sandbox"; paddle_is_sandbox: boolean; app_user_id_source: "custom_data" | "anonymous"; app_user_id_custom_data_key: string; notification_setting_id: string | null; events: string[]; configured: boolean } | null;
  roku?: { roku_channel_id: string | null; roku_channel_name: string | null; configured: boolean } | null;
  galaxy?: { package_name: string | null; service_account_id: string | null; configured: boolean; iap_public_key_configured: boolean } | null;
  /** App Store Small Business Program or Amazon Small Business Accelerator: the dates, and other apps' dates to reuse. */
  small_business_program?: ProgramState | null;
}

export interface ProgramPeriod { entry_date: string; exit_date: string | null }
export interface ProgramState {
  program: "app_store_small_business_program" | "amazon_small_business_accelerator"; rate: number; standard_rate: number;
  enrolled: boolean; periods: ProgramPeriod[]; other_apps: { app_id: string; name: string; enrolled: boolean; periods: ProgramPeriod[] }[];
}

export interface CredentialsCheck { object: "credentials_check"; status: "valid" | "invalid" | "unreachable"; valid: boolean; message: string; checked_at: number; client_email?: string | null; key_id?: string; mode?: "live" | "test"; environment?: "live" | "sandbox"; service_account_id?: string }

export interface SdkVersion {
  app_id: string | null; platform: string; platform_flavor: string; platform_flavor_version: string | null; sdk_version: string;
  /** "verified": the contract tests cover this major version. */
  support: "verified" | "untested"; caveats: string[]; customers_30d: number;
  platform_version: string | null; app_version: string | null; app_build: string | null; bundle_id: string | null; last_app_user_id: string | null;
  first_seen_at: number; last_seen_at: number;
}

export interface RejectedRequests { last_24h: number; last: { at: number; message: string } | null }

export interface SetupHealth {
  apps: {
    id: string; name: string; type: AppType; notification_url: string | null; last_notification_at: number | null; credentials_configured: boolean;
    notification_status?: "ready" | "failing" | "received" | "waiting"; last_notification_error?: { at: number; type: string | null; message: string } | null;
    rejected_requests?: RejectedRequests;
  }[];
  webhooks: { total: number; failing: { id: string; name: string; last_status: number | null; last_error: string | null }[] };
  sdk_versions?: SdkVersion[];
}

export interface Webhook {
  object: "webhook_integration"; id: string; project_id: string; name: string; url: string; environment: "production" | "sandbox" | null;
  event_types: string[]; app_id: string | null; created_at: number; signing_secret?: string;
  /** From GET /v2/projects/:id/webhooks (a RevenueDot extension); false while deliveries are paused. */
  enabled?: boolean;
}

export interface Delivery {
  object: "webhook_delivery"; id: string; webhook_integration_id: string; event_id: string; event_type: string; status: "pending" | "delivered" | "failed";
  attempts: number; next_attempt_at: number | null; response_status: number | null; response_ms: number | null; last_error: string | null; created_at: number;
}

export interface SecretKey { object: "api_key"; id: string; name: string; prefix: string; permissions: string[]; created_at: number; last_used_at: number | null; key?: string }

export type TransferBehavior = "transfer" | "transfer_if_no_active" | "keep" | "share";
export type SandboxAccess = "anybody" | "allowlist" | "nobody";
export interface ProjectSettings {
  object: "project"; id: string; name: string; created_at: number; transfer_behavior: TransferBehavior; sandbox_transfer_behavior: TransferBehavior | null;
  sandbox_testing_access: SandboxAccess; sandbox_testers: string[]; owner: { id: string; email: string; name: string | null } | null;
}

export interface Collaborator { object: "collaborator"; id: string; name: string | null; email: string; role: string; accepted_at: number | null; has_mfa: boolean }

export interface Product {
  object: "product"; id: string; store_identifier: string; type: string; display_name: string | null; app_id: string;
  subscription?: { duration: string | null };
  /** The Test Store price (expand=items.indicative_price); null when there is none. */
  indicative_price?: { amount_micros: number; currency: string } | null;
}

export const STORES: Record<string, { label: string; icon: string; idLabel?: string; idField?: "bundle_id" | "package_name"; notif?: "apple" | "google" | "amazon" | "stripe" | "paddle" | "roku" | "galaxy" }> = {
  app_store: { label: "App Store", icon: "apple", idLabel: "Bundle ID", idField: "bundle_id", notif: "apple" },
  mac_app_store: { label: "Mac App Store", icon: "apple", idLabel: "Bundle ID", idField: "bundle_id", notif: "apple" },
  play_store: { label: "Google Play", icon: "play", idLabel: "Package name", idField: "package_name", notif: "google" },
  test_store: { label: "Test Store", icon: "flask" },
  amazon: { label: "Amazon Appstore", icon: "apps", idLabel: "Package name", idField: "package_name", notif: "amazon" },
  stripe: { label: "Stripe", icon: "web", notif: "stripe" }, rc_billing: { label: "Web Billing", icon: "web" }, roku: { label: "Roku", icon: "apps", notif: "roku" }, paddle: { label: "Paddle", icon: "web", notif: "paddle" },
  galaxy: { label: "Galaxy Store", icon: "phone", idLabel: "Package name", idField: "package_name", notif: "galaxy" },
};

export const storeId = (a: App) => a.app_store?.bundle_id ?? a.mac_app_store?.bundle_id ?? a.play_store?.package_name ?? a.amazon?.package_name ?? a.galaxy?.package_name ?? null;

const all = async <T,>(path: string): Promise<T[]> => {
  const out: T[] = [];
  let next: string | null = `${path}${path.includes("?") ? "&" : "?"}limit=100`;
  for (let i = 0; next && i < 20; i++) {
    const page: List<T> = await api<List<T>>(next);
    out.push(...page.items);
    next = page.next_page;
  }
  return out;
};

export const base = (pid: string) => `/v2/projects/${encodeURIComponent(pid)}`;

export const useApps = (pid: string) => useQuery({ queryKey: ["apps", pid], queryFn: () => all<App>(`${base(pid)}/apps`), enabled: !!pid });
export const useApp = (pid: string, appId: string) => useQuery({ queryKey: ["app", pid, appId], queryFn: () => api<App>(`${base(pid)}/apps/${encodeURIComponent(appId)}`), enabled: !!pid && !!appId, retry: false });
export const usePublicKey = (pid: string, appId: string) => useQuery({
  queryKey: ["public_key", pid, appId], queryFn: async () => (await api<List<PublicKey>>(`${base(pid)}/apps/${encodeURIComponent(appId)}/public_api_keys`)).items[0] ?? null, enabled: !!appId,
});
/** Live: the configuration page shows "last received" and flips to healthy while the developer is setting it up. */
export const useStoreSettings = (pid: string, appId: string) => useQuery({
  queryKey: ["store_settings", pid, appId], queryFn: () => api<StoreSettings>(`${base(pid)}/apps/${encodeURIComponent(appId)}/store_settings`), enabled: !!appId, refetchInterval: 10_000,
});
export const useSetupHealth = (pid: string) => useQuery({ queryKey: ["setup_health", pid], queryFn: () => api<SetupHealth>(`${base(pid)}/setup_health`), enabled: !!pid, refetchInterval: 15_000 });
/** Adds `enabled` to RevenueCat-shaped webhook integrations. */
export async function withStates(pid: string, hooks: Webhook[]): Promise<Webhook[]> {
  const states = await api<List<{ id: string; enabled: boolean }>>(`${base(pid)}/webhooks`);
  const on = new Map(states.items.map((s) => [s.id, s.enabled]));
  return hooks.map((h) => ({ ...h, enabled: on.get(h.id) ?? true }));
}
export const useWebhooks = (pid: string) => useQuery({ queryKey: ["webhooks", pid], queryFn: async () => withStates(pid, await all<Webhook>(`${base(pid)}/integrations/webhooks`)), enabled: !!pid });
export const useProducts = (pid: string, appId?: string) => useQuery({
  queryKey: ["products", pid, appId ?? "all"], queryFn: () => all<Product>(`${base(pid)}/products?expand=items.indicative_price${appId ? `&app_id=${encodeURIComponent(appId)}` : ""}`), enabled: !!pid,
});

/** The server this dashboard talks to: what the SDK's proxy URL and the stores' notification URLs point at. */
/** The server URL apps point at. On RevenueDot Cloud the dashboard host also answers the API, but the public API host is
 *  api.revenuedot.app (what the docs say), so show that. Self-hosted servers serve both from one origin. */
export const apiOrigin = () => (window.location.hostname === "app.revenuedot.app" ? "https://api.revenuedot.app" : window.location.origin);

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Try again.");

/** Third-party integrations and data exports (RevenueDot extensions under /integrations/partners and /integrations/exports). */
export interface IntegrationField { key: string; label: string; type: "text" | "secret" | "select" | "boolean" | "textarea" | "tokens"; required?: boolean; options?: { value: string; label: string }[]; hint?: string; placeholder?: string; when?: { key: string; value: string }; url?: boolean }
export interface IntegrationType { object: "integration_type"; type: string; name: string; category: string; description: string; default_environment: "production" | "sandbox" | null; event_names: boolean; fields: IntegrationField[]; docs_url: string; api?: "documented" | "webhook"; connection?: boolean }
export interface Integration {
  object: "integration"; id: string; type: string; name: string; enabled: boolean; environment: "production" | "sandbox" | null; app_id: string | null;
  event_types: string[]; settings: Record<string, unknown>; secrets: Record<string, { configured: boolean; hint: string | null }>; event_names: Record<string, string>;
  status: { last_delivered_at: number | null; last_error: string | null; consecutive_failures: number; failed_deliveries_in_row?: number }; created_at: number;
}
export interface IntegrationDelivery {
  object: "integration_delivery"; id: string; event_id: string; event_type: string; status: "pending" | "delivered" | "failed" | "skipped"; attempts: number; sent_as: string | null;
  next_attempt_at: number | null; request: string | null; request_body: string | null; response_status: number | null; response_ms: number | null; response_body: string | null; last_error: string | null; created_at: number;
}
export interface DataExport {
  object: "data_export"; id: string; name: string; enabled: boolean; destination: "s3" | "r2" | "gcs" | "azure" | "email";
  config: {
    bucket: string | null; prefix: string | null; region: string | null; endpoint: string | null; account_id: string | null; access_key_id: string | null;
    credential_type: "service_account" | "hmac" | null; recipients: string[] | null; subject_prefix: string | null;
  };
  credentials: Record<string, { configured: boolean; hint: string | null }>; format: "csv" | "parquet"; compression: "gzip" | "none"; schedule: "daily" | "weekly" | "interval";
  hour_utc: number; weekday: number | null; interval_hours: number | null; mode: "incremental" | "full"; split_files: boolean; tables: string[]; columns: Record<string, string[]>; environment: "production" | "sandbox" | null;
  next_run_at: number | null; last_run_at: number | null; last_error: string | null; consecutive_failures: number; created_at: number;
}
export interface ExportRun {
  object: "data_export_run"; id: string; status: "queued" | "running" | "succeeded" | "failed"; trigger: "schedule" | "manual"; mode: "incremental" | "full";
  window_start: number | null; window_end: number; attempts: number; next_attempt_at: number | null; files: { table: string; key: string; rows: number; bytes: number }[];
  rows: number; bytes: number; error: string | null; started_at: number | null; finished_at: number | null; created_at: number;
}
export const useIntegrationTypes = (pid: string) => useQuery({ queryKey: ["integration_types", pid], queryFn: async () => (await api<List<IntegrationType>>(`${base(pid)}/integrations/catalog`)).items, enabled: !!pid, staleTime: 300_000 });
export const useIntegrations = (pid: string) => useQuery({ queryKey: ["integrations", pid], queryFn: () => all<Integration>(`${base(pid)}/integrations/partners`), enabled: !!pid });
export interface ExportTableColumns { object: "data_export_table"; table: string; columns: { name: string; type: string }[] }
export const useExportColumns = (pid: string) => useQuery({ queryKey: ["export_columns", pid], queryFn: async () => (await api<List<ExportTableColumns>>(`${base(pid)}/integrations/exports/columns`)).items, enabled: !!pid, staleTime: 300_000 });
export const useExports = (pid: string) => useQuery({ queryKey: ["exports", pid], queryFn: () => all<DataExport>(`${base(pid)}/integrations/exports`), enabled: !!pid });
