import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** RevenueCat backend error codes the SDKs understand. */
export const Codes = {
  INVALID_API_KEY: 7225,
  INVALID_AUTH_TOKEN: 7224,
  RECEIPT_ALREADY_IN_USE: 7102,
  INVALID_RECEIPT: 7103,
  INVALID_APP_USER_ID: 7220,
  INVALID_SUBSCRIBER_ATTRIBUTES: 7263,
  NOT_FOUND: 7259,
  STORE_PROBLEM: 7101,
  UNSUPPORTED_RECEIPT: 7662,
  INTERNAL: 7110,
  BAD_REQUEST: 7000,
  INVALID_APPLE_SUBSCRIPTION_KEY: 7234,
} as const;

export class RCError extends Error {
  constructor(public status: ContentfulStatusCode, public code: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** Errors always carry a JSON body with application/json (iOS ignores bodies otherwise; Android fails on empty bodies). */
export function errorResponse(c: Context, e: unknown) {
  if (e instanceof RCError) return c.json({ code: e.code, message: e.message, ...e.extra }, e.status);
  console.error(e);
  // 5xx keeps purchases unfinished on the device, so the SDK retries. Never answer 4xx for our own failures.
  return c.json({ code: Codes.INTERNAL, message: "Internal server error." }, 500);
}
