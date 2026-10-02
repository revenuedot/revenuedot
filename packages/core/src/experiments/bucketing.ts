/**
 * Deterministic experiment assignment (prd/experiments/PRD.md §2). A customer's numbers come from SHA-256 of a seed, so
 * the same customer always gets the same answer on every server, with nothing stored until they are enrolled.
 */

/** The first two bytes of SHA-256(seed), 0..65535. */
export async function hash16(seed: string): Promise<number> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
  return (h[0]! << 8) | h[1]!;
}

/** 0..99: whether the customer is inside the enrollment share (`< enrollment_percent`). Unchanged since the first release. */
export const enrollBucket = async (experimentId: string, customerId: string) => (await hash16(`${experimentId}:enroll:${customerId}`)) % 100;

/**
 * The variant index for a 16-bit hash and `n` variants. When 100 splits evenly (2 or 4 variants) the 0..99 bucket is cut
 * into equal ranges, so two variants split exactly as before multi-variant experiments (`u % 100 < 50` → a). Three
 * variants use `u % 3` (65,536 is one more than a multiple of 3, so the split is even to 0.002%).
 */
export function variantIndex(u: number, n: number): number {
  if (n <= 1) return 0;
  if (100 % n === 0) return Math.floor((u % 100) / (100 / n));
  return u % n;
}

export async function assignVariant(experimentId: string, customerId: string, variantIds: readonly string[]): Promise<string> {
  return variantIds[variantIndex(await hash16(`${experimentId}:variant:${customerId}`), variantIds.length)]!;
}
