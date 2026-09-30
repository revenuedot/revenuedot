import type { PeriodType, Store } from "@revenuedot/core";
import type { VerifiedPurchase, VerifiedSubscription } from "../types.js";

/** JWSTransactionDecodedPayload (the fields we use). Dates are epoch milliseconds, prices milliunits. */
export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate: number;
  originalPurchaseDate: number;
  expiresDate?: number;
  type: "Auto-Renewable Subscription" | "Non-Consumable" | "Consumable" | "Non-Renewing Subscription";
  inAppOwnershipType?: "PURCHASED" | "FAMILY_SHARED";
  appAccountToken?: string;
  revocationDate?: number;
  revocationReason?: number;
  isUpgraded?: boolean;
  offerType?: number;
  offerDiscountType?: "FREE_TRIAL" | "PAY_AS_YOU_GO" | "PAY_UP_FRONT" | string;
  environment: "Production" | "Sandbox" | "Xcode" | "LocalTesting" | string;
  storefront?: string;
  price?: number;
  currency?: string;
  signedDate?: number;
}

/** JWSRenewalInfoDecodedPayload (the fields we use). */
export interface AppleRenewalInfo {
  originalTransactionId: string;
  productId?: string;
  autoRenewProductId?: string;
  autoRenewStatus?: 0 | 1;
  isInBillingRetryPeriod?: boolean;
  gracePeriodExpiresDate?: number;
  /** 1 customer cancelled, 2 billing error, 3 declined a price increase, 4 product unavailable, 5 other. */
  expirationIntent?: number;
  signedDate?: number;
}

export const AUTO_RENEWABLE = "Auto-Renewable Subscription";

/**
 * Period type in RevenueCat's vocabulary. Free offers are TRIAL; paid introductory offers and paid offer codes are INTRO;
 * paid promotional and win-back offers report NORMAL (RevenueCat keeps PROMOTIONAL for its own granted entitlements).
 */
export function periodTypeOf(tx: Pick<AppleTransaction, "offerType" | "offerDiscountType" | "price">): PeriodType {
  if (!tx.offerType) return "normal";
  const free = tx.offerDiscountType === "FREE_TRIAL" || tx.price === 0;
  if (free) return "trial";
  return tx.offerType === 1 || tx.offerType === 3 ? "intro" : "normal";
}

export interface MapOptions {
  store: Store;
  renewal?: AppleRenewalInfo | null;
  /** When Apple's data says nothing, the moment we learned about a change (notification signedDate or now). */
  detectedAt: Date;
  /** Detection times already stored for this chain, kept so re-applying the same state does not move them. */
  previous?: { unsubscribeDetectedAt: Date | null; billingIssuesDetectedAt: Date | null } | null;
  /** Overrides from the notification type when the renewal info is missing or lags. */
  autoRenew?: boolean;
  billingIssue?: boolean;
}

const date = (ms?: number | null) => (typeof ms === "number" ? new Date(ms) : null);

/** Maps a verified transaction (plus renewal info, when known) to what the purchase service stores. */
export function fromTransaction(tx: AppleTransaction, o: MapOptions): VerifiedPurchase {
  const isSandbox = tx.environment !== "Production";
  const price = typeof tx.price === "number" && tx.currency ? { amount: tx.price / 1000, currency: tx.currency } : null;
  const countryCode = alpha2(tx.storefront);
  const purchaseDate = new Date(tx.purchaseDate);
  if (tx.type !== AUTO_RENEWABLE) {
    return {
      kind: "non_subscription", store: o.store, productIdentifier: tx.productId, storeTransactionId: tx.transactionId, isSandbox,
      isConsumable: tx.type === "Consumable", purchaseDate, refundedAt: date(tx.revocationDate), price, countryCode,
    };
  }
  const r = o.renewal;
  const expiresDate = date(tx.expiresDate);
  const grace = date(r?.gracePeriodExpiresDate);
  const billingIssue = o.billingIssue ?? (r?.isInBillingRetryPeriod === true || r?.expirationIntent === 2);
  // A billing failure also counts as a cancellation (cancel_reason BILLING_ERROR), as RevenueCat reports it.
  const unsubscribed = (o.autoRenew !== undefined ? !o.autoRenew : r?.autoRenewStatus === 0) || billingIssue;
  // Renewals fail at the period end, so that is when the billing issue started.
  const failedAt = expiresDate && expiresDate < o.detectedAt ? expiresDate : o.detectedAt;
  const billingIssuesDetectedAt = billingIssue ? o.previous?.billingIssuesDetectedAt ?? failedAt : null;
  const sub: VerifiedSubscription = {
    kind: "subscription", store: o.store, storeKey: tx.originalTransactionId, productIdentifier: tx.productId, isSandbox,
    purchaseDate, originalPurchaseDate: new Date(tx.originalPurchaseDate), expiresDate, periodType: periodTypeOf(tx),
    ownershipType: tx.inAppOwnershipType === "FAMILY_SHARED" ? "FAMILY_SHARED" : "PURCHASED",
    unsubscribeDetectedAt: unsubscribed ? o.previous?.unsubscribeDetectedAt ?? billingIssuesDetectedAt ?? o.detectedAt : null,
    billingIssuesDetectedAt,
    gracePeriodExpiresDate: billingIssue && grace && (!expiresDate || grace > expiresDate) ? grace : null,
    refundedAt: date(tx.revocationDate), storeTransactionId: tx.transactionId, originalTransactionId: tx.originalTransactionId,
    price, countryCode, autoRenewProductId: r?.autoRenewProductId ?? null,
  };
  return sub;
}

/** The latest transaction of each subscription chain, and every one-time transaction. */
export function latestPerChain(txs: AppleTransaction[]): AppleTransaction[] {
  const chains = new Map<string, AppleTransaction>();
  const oneTime = new Map<string, AppleTransaction>();
  for (const tx of txs) {
    if (tx.type !== AUTO_RENEWABLE) { oneTime.set(tx.transactionId, tx); continue; }
    const cur = chains.get(tx.originalTransactionId);
    // An upgraded transaction was replaced by the one for the higher product, even when bought at the same moment.
    const better = !cur || (cur.isUpgraded && !tx.isUpgraded) || (!!cur.isUpgraded === !!tx.isUpgraded && tx.purchaseDate > cur.purchaseDate);
    if (better) chains.set(tx.originalTransactionId, tx);
  }
  return [...chains.values(), ...oneTime.values()];
}

/** App Store storefronts are ISO 3166-1 alpha-3; RevenueCat reports alpha-2. */
const A3_TO_A2 = Object.fromEntries((
  "AFG:AF,ALB:AL,DZA:DZ,AGO:AO,AIA:AI,ATG:AG,ARG:AR,ARM:AM,AUS:AU,AUT:AT,AZE:AZ,BHS:BS,BHR:BH,BRB:BB,BLR:BY,BEL:BE,BLZ:BZ,BEN:BJ," +
  "BMU:BM,BTN:BT,BOL:BO,BIH:BA,BWA:BW,BRA:BR,VGB:VG,BRN:BN,BGR:BG,BFA:BF,KHM:KH,CMR:CM,CAN:CA,CPV:CV,CYM:KY,TCD:TD,CHL:CL,CHN:CN," +
  "COL:CO,COD:CD,COG:CG,CRI:CR,CIV:CI,HRV:HR,CYP:CY,CZE:CZ,DNK:DK,DMA:DM,DOM:DO,ECU:EC,EGY:EG,SLV:SV,EST:EE,SWZ:SZ,FJI:FJ,FIN:FI," +
  "FRA:FR,GAB:GA,GMB:GM,GEO:GE,DEU:DE,GHA:GH,GRC:GR,GRD:GD,GTM:GT,GNB:GW,GUY:GY,HND:HN,HKG:HK,HUN:HU,ISL:IS,IND:IN,IDN:ID,IRQ:IQ," +
  "IRL:IE,ISR:IL,ITA:IT,JAM:JM,JPN:JP,JOR:JO,KAZ:KZ,KEN:KE,KOR:KR,XKS:XK,KWT:KW,KGZ:KG,LAO:LA,LVA:LV,LBN:LB,LBR:LR,LBY:LY,LTU:LT," +
  "LUX:LU,MAC:MO,MDG:MG,MWI:MW,MYS:MY,MDV:MV,MLI:ML,MLT:MT,MRT:MR,MUS:MU,MEX:MX,FSM:FM,MDA:MD,MNG:MN,MNE:ME,MSR:MS,MAR:MA,MOZ:MZ," +
  "MMR:MM,NAM:NA,NRU:NR,NPL:NP,NLD:NL,NZL:NZ,NIC:NI,NER:NE,NGA:NG,MKD:MK,NOR:NO,OMN:OM,PAK:PK,PLW:PW,PAN:PA,PNG:PG,PRY:PY,PER:PE," +
  "PHL:PH,POL:PL,PRT:PT,QAT:QA,ROU:RO,RUS:RU,RWA:RW,KNA:KN,LCA:LC,VCT:VC,WSM:WS,STP:ST,SAU:SA,SEN:SN,SRB:RS,SYC:SC,SLE:SL,SGP:SG," +
  "SVK:SK,SVN:SI,SLB:SB,ZAF:ZA,ESP:ES,LKA:LK,SUR:SR,SWE:SE,CHE:CH,TWN:TW,TJK:TJ,TZA:TZ,THA:TH,TON:TO,TTO:TT,TUN:TN,TUR:TR,TKM:TM," +
  "TCA:TC,UGA:UG,UKR:UA,ARE:AE,GBR:GB,USA:US,URY:UY,UZB:UZ,VUT:VU,VEN:VE,VNM:VN,YEM:YE,ZMB:ZM,ZWE:ZW,CUB:CU,IRN:IR,SYR:SY,PRK:KP," +
  "ETH:ET,SOM:SO,SDN:SD,SSD:SS,ERI:ER,DJI:DJ,COM:KM,BDI:BI,CAF:CF,GIN:GN,GNQ:GQ,TGO:TG,LSO:LS,MHL:MH,KIR:KI,TUV:TV,TLS:TL,PSE:PS," +
  "PRI:PR,GUM:GU,VIR:VI,ASM:AS,MNP:MP,GRL:GL,FRO:FO,GIB:GI,AND:AD,MCO:MC,SMR:SM,LIE:LI,VAT:VA,REU:RE,GLP:GP,MTQ:MQ,GUF:GF,MYT:YT," +
  "NCL:NC,PYF:PF,ABW:AW,CUW:CW,SXM:SX,BES:BQ,IMN:IM,JEY:JE,GGY:GG,ALA:AX,SJM:SJ,SPM:PM,WLF:WF,COK:CK,NIU:NU,TKL:TK,PCN:PN,SHN:SH," +
  "FLK:FK,IOT:IO,CXR:CX,CCK:CC,NFK:NF,HMD:HM,ATF:TF,SGS:GS,UMI:UM,BVT:BV,ATA:AQ,ESH:EH,MAF:MF,BLM:BL"
).split(",").map((p) => p.split(":") as [string, string]));

/** Alpha-2 country code from an App Store storefront or an SDK `store_country` (alpha-3, or already alpha-2). */
export function alpha2(code?: string | null): string | null {
  if (!code) return null;
  const c = code.toUpperCase();
  if (c.length === 2) return c;
  return A3_TO_A2[c] ?? null;
}
