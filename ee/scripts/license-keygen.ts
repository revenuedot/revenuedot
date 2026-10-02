// RevenueDot Enterprise (ee/LICENSE). Makes the Ed25519 key pair that signs licence keys.
//   pnpm tsx ee/scripts/license-keygen.ts
// Prints the public key (pin it in ee/server/license.ts LICENSE_PUBLIC_KEYS) on stderr and the private key seed on
// stdout, so it can go straight into 1Password without touching the disk:
//   pnpm tsx ee/scripts/license-keygen.ts | op item create --vault RevenueDot --category password --title "RevenueDot Enterprise licence signing key" "password[password]=$(cat)"
import { generateSigningKeyPair } from "../../apps/server/src/services/signing.js";

const { privateKey, publicKey } = await generateSigningKeyPair();
console.error(`Public key (pin in ee/server/license.ts): ${publicKey}`);
process.stdout.write(privateKey);
