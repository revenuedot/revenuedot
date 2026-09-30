// Generates a root key for response signing (the RevenueCat SDK "Trusted Entitlements" feature).
// Usage: pnpm tsx scripts/signing-keygen.ts
// Put the first line in the server's environment; apps verify responses with the public key.
import { generateSigningKeyPair } from "../apps/server/src/services/signing.js";

const { privateKey, publicKey } = await generateSigningKeyPair();
console.log(`REVENUEDOT_SIGNING_KEY=${privateKey}`);
console.log(`public key: ${publicKey}`);
