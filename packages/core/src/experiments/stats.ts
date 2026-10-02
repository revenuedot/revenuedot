/**
 * The statistics behind experiment results (prd/experiments/PRD.md §4). Everything is 95% two-sided unless a `z` is given.
 * - Rates: Wilson score interval; chance to beat the control from Beta(k+1, n−k+1) posteriors (uniform prior), exact by
 *   Evan Miller's closed form (https://www.evanmiller.org/bayesian-ab-testing.html#binary_ab_equivalent), with a normal
 *   approximation of the two Betas when the sum would be long.
 * - Per-customer means (revenue, MRR): normal interval from the sample standard deviation (central limit theorem);
 *   chance to beat the control from the normal approximation of the difference of means.
 * - Lift (variant ÷ control − 1): delta method on the log of the ratio, so the interval is asymmetric and above −100%.
 * - Sample size: customers per variant to detect a relative lift at 95% confidence and 80% power.
 */

export const Z95 = 1.959963984540054;
export const Z80 = 0.8416212335729143;

/** Standard normal CDF, via erfc (W. J. Cody's rational approximations as in Numerical Recipes' erfc, |error| < 1.2e-7). */
export function normalCdf(z: number): number {
  if (Number.isNaN(z)) return NaN;
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const erfc = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return z >= 0 ? 1 - erfc / 2 : erfc / 2;
}

/** Inverse of the standard normal CDF (Acklam's algorithm, relative error < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425, hi = 1 - lo;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > hi) return -normalQuantile(1 - p);
  const q = p - 0.5, r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** log Γ(x) for x > 0 (Lanczos, g = 7, n = 9; about 15 significant digits). */
export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const g = 7;
  const coef = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  const y = x - 1;
  let a = coef[0]!;
  const t = y + g + 0.5;
  for (let i = 1; i < 9; i++) a += coef[i]! / (y + i);
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}
export const logBeta = (a: number, b: number) => logGamma(a) + logGamma(b) - logGamma(a + b);

export interface Interval { lower: number; upper: number }

/** Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z = Z95): Interval | null {
  if (n <= 0) return null;
  const p = k / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

/** Exact P(X_b > X_a) for X_a ~ Beta(aA, bA), X_b ~ Beta(aB, bB), aB a positive integer (Evan Miller). */
function betaWinExact(aA: number, bA: number, aB: number, bB: number): number {
  let total = 0;
  const base = logBeta(aA, bA);
  for (let i = 0; i < aB; i++) total += Math.exp(logBeta(aA + i, bA + bB) - Math.log(bB + i) - logBeta(1 + i, bB) - base);
  return total;
}
const EXACT_TERMS = 20_000;

/** P(rate of b > rate of a) with uniform priors: k successes out of n for each. */
export function chanceRateBeats(kB: number, nB: number, kA: number, nA: number): number {
  const aA = kA + 1, bA = nA - kA + 1, aB = kB + 1, bB = nB - kB + 1;
  let p: number;
  if (Math.min(aA, aB) <= EXACT_TERMS) {
    // The sum runs over the first argument's alpha; swap when the other is shorter (P(B > A) = 1 − P(A > B)).
    p = aB <= aA ? betaWinExact(aA, bA, aB, bB) : 1 - betaWinExact(aB, bB, aA, bA);
  } else if (Math.min(bA, bB) <= EXACT_TERMS) {
    // Rates near 100%: the same sum over failures. 1 − p ~ Beta(β, α), and P(p_B > p_A) = P(1 − p_A > 1 − p_B).
    p = bA <= bB ? betaWinExact(bB, aB, bA, aA) : 1 - betaWinExact(bA, aA, bB, aB);
  } else {
    const m = (a: number, b: number) => a / (a + b);
    const v = (a: number, b: number) => (a * b) / ((a + b) ** 2 * (a + b + 1));
    p = normalCdf((m(aB, bB) - m(aA, bA)) / Math.sqrt(v(aA, bA) + v(aB, bB)));
  }
  return Math.min(1, Math.max(0, p));
}

export interface Summary { n: number; mean: number; sd: number; se: number }
/** Mean, sample standard deviation and standard error of `values` plus `zeros` more values of 0. */
export function summarize(values: number[], zeros = 0): Summary {
  const n = values.length + zeros;
  if (!n) return { n: 0, mean: 0, sd: 0, se: 0 };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let ss = zeros * mean * mean;
  for (const v of values) ss += (v - mean) ** 2;
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  return { n, mean, sd, se: sd / Math.sqrt(n) };
}

/**
 * Normal interval for a mean, from two customers on (one customer has no spread to measure). The lower bound stops at 0
 * when the mean is not negative: revenue and MRR per customer cannot be negative on average here.
 */
export function meanInterval(s: Summary, z = Z95, floorAtZero = true): Interval | null {
  if (s.n < 2) return null;
  const lower = s.mean - z * s.se;
  return { lower: floorAtZero && s.mean >= 0 ? Math.max(0, lower) : lower, upper: s.mean + z * s.se };
}

/** P(mean of b > mean of a), normal approximation of the difference; null below two customers on either side. */
export function chanceMeanBeats(b: Summary, a: Summary): number | null {
  if (a.n < 2 || b.n < 2) return null;
  const se = Math.sqrt(a.se ** 2 + b.se ** 2);
  if (se === 0) return b.mean > a.mean ? 1 : b.mean < a.mean ? 0 : 0.5;
  return normalCdf((b.mean - a.mean) / se);
}

/**
 * Relative lift of b over a and its interval by the delta method on log(b/a): Var(log x̂) ≈ se²/x². For rates
 * se² = p(1−p)/n. Null when either value is 0 (the ratio is undefined).
 */
export function liftInterval(b: { value: number; se: number }, a: { value: number; se: number }, z = Z95): { lift: number; lower: number; upper: number } | null {
  if (!(a.value > 0) || !(b.value > 0)) return null;
  const lr = Math.log(b.value / a.value);
  const v = (b.se / b.value) ** 2 + (a.se / a.value) ** 2;
  const h = z * Math.sqrt(v);
  return { lift: b.value / a.value - 1, lower: Math.exp(lr - h) - 1, upper: Math.exp(lr + h) - 1 };
}
export const rateSe = (k: number, n: number) => (n > 0 ? Math.sqrt(((k / n) * (1 - k / n)) / n) : 0);

/**
 * Relative lift of rate kB/nB over kA/nA with Katz's log interval (the delta method on log of the ratio, as
 * `liftInterval`). When a count is 0 or all of n, half a success and half a failure are added on both sides (Haldane),
 * so 0 of 100 against 20 of 100 gets −100% with an interval, and 3 of 3 against 2 of 2 is not certain. Null when the
 * control's rate is 0 (the ratio is undefined).
 */
export function rateLift(kB: number, nB: number, kA: number, nA: number, z = Z95): { lift: number; lower: number; upper: number } | null {
  if (!(nA > 0) || !(nB > 0) || !(kA > 0)) return null;
  const lift = kB / nB / (kA / nA) - 1;
  const fix = kB === 0 || kB === nB || kA === nA;
  const a = fix ? kB + 0.5 : kB, n1 = fix ? nB + 1 : nB, c = fix ? kA + 0.5 : kA, n2 = fix ? nA + 1 : nA;
  const lr = Math.log(a / n1 / (c / n2));
  const h = z * Math.sqrt(Math.max(0, 1 / a - 1 / n1 + 1 / c - 1 / n2));
  return { lift, lower: Math.min(lift, Math.exp(lr - h) - 1), upper: Math.max(lift, Math.exp(lr + h) - 1) };
}

/** Customers per variant to detect a relative lift `mde` on a rate `p` (two-sided α = 0.05, power 0.8). */
export function sampleSizeRate(p: number, mde = 0.2, zA = Z95, zB = Z80): number | null {
  const p2 = p * (1 + mde);
  if (!(p > 0) || p2 >= 1) return null;
  return Math.ceil(((zA + zB) ** 2 * (p * (1 - p) + p2 * (1 - p2))) / (p2 - p) ** 2);
}
/** Customers per variant to detect a relative lift `mde` on a mean with standard deviation `sd`. */
export function sampleSizeMean(mean: number, sd: number, mde = 0.2, zA = Z95, zB = Z80): number | null {
  const delta = mean * mde;
  if (!(delta > 0) || !(sd > 0)) return null;
  return Math.ceil((2 * (zA + zB) ** 2 * sd * sd) / (delta * delta));
}
