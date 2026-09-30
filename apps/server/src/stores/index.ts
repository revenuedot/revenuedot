import type { StoreAdapter } from "./types.js";
import { testStore } from "./test-store.js";

/** Store adapters by app type. App Store and Google Play adapters register here. */
export function defaultStores(): Record<string, StoreAdapter> {
  return { test_store: testStore };
}
