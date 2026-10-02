/**
 * The Stripe Connect platform RevenueDot runs for "Connect with Stripe" (prd/web-billing/PRD.md §8). Its keys come from the
 * environment and are Kai's to add; without a client id, a secret key and a webhook secret, Connect is unavailable and
 * developers paste a restricted key instead.
 */
export interface StripeConnectConfig {
  /** The platform's OAuth client id (ca_…). */
  clientId?: string;
  /** The platform's secret key (sk_live_…, or sk_test_… for a test-only platform). */
  secretKey?: string;
  /** Optional sk_test_…: connections in test mode act with it. */
  testSecretKey?: string;
  /** Signing secrets of the platform's Connect webhook endpoints (live and test). */
  webhookSecrets: string[];
}

const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/** REVENUEDOT_STRIPE_CONNECT_{CLIENT_ID,SECRET_KEY,TEST_SECRET_KEY,WEBHOOK_SECRET}; undefined when none is set. */
export function stripeConnectFromEnv(env: Record<string, string | undefined>): StripeConnectConfig | undefined {
  const cfg: StripeConnectConfig = {
    clientId: clean(env.REVENUEDOT_STRIPE_CONNECT_CLIENT_ID),
    secretKey: clean(env.REVENUEDOT_STRIPE_CONNECT_SECRET_KEY),
    testSecretKey: clean(env.REVENUEDOT_STRIPE_CONNECT_TEST_SECRET_KEY),
    webhookSecrets: (env.REVENUEDOT_STRIPE_CONNECT_WEBHOOK_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
  return cfg.clientId || cfg.secretKey || cfg.testSecretKey || cfg.webhookSecrets.length ? cfg : undefined;
}

const isTest = (k: string) => /^sk_test_/.test(k);

/** The platform key that acts for a connection in `mode`: live needs a live key; test takes the test key or a test primary. */
export function platformKeyFor(cfg: StripeConnectConfig | undefined, mode: "live" | "test"): string | null {
  if (!cfg) return null;
  if (mode === "test") return cfg.testSecretKey ?? (cfg.secretKey && isTest(cfg.secretKey) ? cfg.secretKey : null);
  return cfg.secretKey && !isTest(cfg.secretKey) ? cfg.secretKey : null;
}

/** Modes a developer can connect in with this configuration. */
export function connectModes(cfg: StripeConnectConfig | undefined): Array<"live" | "test"> {
  return (["live", "test"] as const).filter((m) => !!platformKeyFor(cfg, m));
}

/** What is missing for Connect to work (empty: available). */
export function connectMissing(cfg: StripeConnectConfig | undefined): string[] {
  const out: string[] = [];
  if (!cfg?.clientId) out.push("REVENUEDOT_STRIPE_CONNECT_CLIENT_ID");
  if (!cfg?.secretKey && !cfg?.testSecretKey) out.push("REVENUEDOT_STRIPE_CONNECT_SECRET_KEY");
  if (!cfg?.webhookSecrets.length) out.push("REVENUEDOT_STRIPE_CONNECT_WEBHOOK_SECRET");
  return out;
}
