/** Test-only Amazon and Stripe values the e2e fakes accept (store-fakes.ts) and stores.spec.ts sends. Never real keys. */
export const E2E_STRIPE_KEY = "rk_test_51E2eOnlyRevenueDotFakeKey0000000000";
export const E2E_STRIPE_WHSEC = "whsec_e2eonlyrevenuedotsigningsecret";
export const E2E_AMAZON_SECRET = "2:e2e-only-amazon-shared-key:AbC=";
export const E2E_STRIPE_SUB = "sub_1E2eSubscription";
/** Store import (store-import.spec.ts): the App Store Connect key ids and the Play service account the fakes accept. */
export const E2E_ASC_KEY_ID = "E2EASCKEY1";
export const E2E_ASC_FORBIDDEN_KEY_ID = "E2EASCDENY";
export const E2E_ASC_ISSUER = "e2e00000-0000-4000-8000-000000000001";
export const E2E_IMPORT_BUNDLE = "com.example.e2e.import";
export const E2E_PLAY_EMAIL = "e2e-import@e2e-project.iam.gserviceaccount.com";
/** An App Store Connect key whose app has no products yet, and a Play service account without "View app information". */
export const E2E_ASC_EMPTY_KEY_ID = "E2EASCNONE";
export const E2E_PLAY_DENIED_EMAIL = "e2e-denied@e2e-project.iam.gserviceaccount.com";
