import type { StoreAdapter } from "./types.js";
import { testStore } from "./test-store.js";
import { appleStore } from "./apple/index.js";
import { googleStore } from "./google/index.js";
import { amazonStore } from "./amazon/index.js";
import { stripeStore } from "./stripe/index.js";

/** Store adapters by app type. */
export function defaultStores(): Record<string, StoreAdapter> {
  return { test_store: testStore, app_store: appleStore, play_store: googleStore, amazon: amazonStore, stripe: stripeStore };
}
