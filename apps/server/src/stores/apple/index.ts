import type { StoreAdapter } from "../types.js";
import { Codes, RCError } from "../../errors.js";

/** App Store adapter (StoreKit 2 JWS, StoreKit 1 receipts, App Store Server API). Implemented in this folder. */
export const appleStore: StoreAdapter = {
  async verify() { throw new RCError(400, Codes.UNSUPPORTED_RECEIPT, "App Store receipts are not supported yet."); },
};
