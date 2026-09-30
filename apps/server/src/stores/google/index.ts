import type { StoreAdapter } from "../types.js";
import { Codes, RCError } from "../../errors.js";

/** Google Play adapter (Play Developer API). Implemented in this folder. */
export const googleStore: StoreAdapter = {
  async verify() { throw new RCError(400, Codes.UNSUPPORTED_RECEIPT, "Google Play purchases are not supported yet."); },
};
