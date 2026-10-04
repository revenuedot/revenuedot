/**
 * Test Store prices by currency (prd/catalog/PRD.md "Test Store prices by currency"). A Test Store product has one price
 * per currency; one of them is the default. The SDK is shown the price in the customer's currency, else the default.
 */
export interface CurrencyPrice { currency: string; amount_micros: number }

/** ISO 4217 currency of each country (ISO 3166-1 alpha-2), grouped by currency. */
const BY_CURRENCY: Record<string, string> = {
  USD: "US AS BQ EC FM GU IO MH MP PR PW SV TC TL UM VG VI",
  EUR: "AD AT AX BE BL CY DE EE ES FI FR GF GP GR HR IE IT LT LU LV MC ME MF MQ MT NL PM PT RE SI SK SM TF VA XK YT",
  GBP: "GB GG IM JE GS", AUD: "AU CC CX HM KI NF NR TV", NZD: "NZ CK NU PN TK", CHF: "CH LI", NOK: "NO SJ BV", DKK: "DK FO GL",
  XOF: "BF BJ CI GW ML NE SN TG", XAF: "CF CG CM GA GQ TD", XCD: "AG AI DM GD KN LC MS VC", XPF: "NC PF WF", ANG: "CW SX",
  MAD: "MA EH", ZAR: "ZA", INR: "IN", ILS: "IL PS",
  AED: "AE", AFN: "AF", ALL: "AL", AMD: "AM", AOA: "AO", ARS: "AR", AWG: "AW", AZN: "AZ", BAM: "BA", BBD: "BB", BDT: "BD",
  BGN: "BG", BHD: "BH", BIF: "BI", BMD: "BM", BND: "BN", BOB: "BO", BRL: "BR", BSD: "BS", BTN: "BT", BWP: "BW", BYN: "BY",
  BZD: "BZ", CAD: "CA", CDF: "CD", CLP: "CL", CNY: "CN", COP: "CO", CRC: "CR", CUP: "CU", CVE: "CV", CZK: "CZ", DJF: "DJ",
  DOP: "DO", DZD: "DZ", EGP: "EG", ERN: "ER", ETB: "ET", FJD: "FJ", FKP: "FK", GEL: "GE", GHS: "GH", GIP: "GI", GMD: "GM",
  GNF: "GN", GTQ: "GT", GYD: "GY", HKD: "HK", HNL: "HN", HTG: "HT", HUF: "HU", IDR: "ID", IQD: "IQ", IRR: "IR", ISK: "IS",
  JMD: "JM", JOD: "JO", JPY: "JP", KES: "KE", KGS: "KG", KHR: "KH", KMF: "KM", KPW: "KP", KRW: "KR", KWD: "KW", KYD: "KY",
  KZT: "KZ", LAK: "LA", LBP: "LB", LKR: "LK", LRD: "LR", LSL: "LS", LYD: "LY", MDL: "MD", MGA: "MG", MKD: "MK", MMK: "MM",
  MNT: "MN", MOP: "MO", MRU: "MR", MUR: "MU", MVR: "MV", MWK: "MW", MXN: "MX", MYR: "MY", MZN: "MZ", NAD: "NA", NGN: "NG",
  NIO: "NI", NPR: "NP", OMR: "OM", PAB: "PA", PEN: "PE", PGK: "PG", PHP: "PH", PKR: "PK", PLN: "PL", PYG: "PY", QAR: "QA",
  RON: "RO", RSD: "RS", RUB: "RU", RWF: "RW", SAR: "SA", SBD: "SB", SCR: "SC", SDG: "SD", SEK: "SE", SGD: "SG", SHP: "SH",
  SLE: "SL", SOS: "SO", SRD: "SR", SSP: "SS", STN: "ST", SYP: "SY", SZL: "SZ", THB: "TH", TJS: "TJ", TMT: "TM", TND: "TN",
  TOP: "TO", TRY: "TR", TTD: "TT", TWD: "TW", TZS: "TZ", UAH: "UA", UGX: "UG", UYU: "UY", UZS: "UZ", VES: "VE", VND: "VN",
  VUV: "VU", WST: "WS", YER: "YE", ZMW: "ZM", ZWG: "ZW",
};
const COUNTRY_CURRENCY: Record<string, string> = Object.fromEntries(
  Object.entries(BY_CURRENCY).flatMap(([currency, countries]) => countries.split(" ").map((c) => [c, currency] as const)),
);

/** The currency of a country (two-letter code), or null when unknown. */
export function currencyOfCountry(country: string | null | undefined): string | null {
  return country ? COUNTRY_CURRENCY[country.toUpperCase()] ?? null : null;
}

/**
 * Every price of a product, default first, then by currency. `fallback` is the product's default price as stored on the
 * product; it is listed even when its row is missing (a product written before prices by currency existed).
 */
export function priceList(fallback: CurrencyPrice | null, rows: CurrencyPrice[]): CurrencyPrice[] {
  const byCurrency = new Map(rows.map((r) => [r.currency.toUpperCase(), { currency: r.currency.toUpperCase(), amount_micros: r.amount_micros }]));
  const def = fallback ? byCurrency.get(fallback.currency.toUpperCase()) ?? { currency: fallback.currency.toUpperCase(), amount_micros: fallback.amount_micros } : null;
  if (def) byCurrency.delete(def.currency);
  return [...(def ? [def] : []), ...[...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency))];
}

/**
 * The price to show a customer: in the currency they asked for (purchases-js sends `currency`), else in their country's
 * currency (the SDK's storefront, or where the customer was last seen), else the default (the first of `prices`).
 */
export function pickPrice<T extends CurrencyPrice>(prices: T[], want: { currency?: string | null; country?: string | null }): T | null {
  const find = (c: string | null | undefined) => (c ? prices.find((p) => p.currency === c.toUpperCase()) : undefined);
  return find(want.currency) ?? find(currencyOfCountry(want.country)) ?? prices[0] ?? null;
}

/** The default price after `removed` is gone: USD when there is one, else the first currency alphabetically. */
export function nextDefault<T extends CurrencyPrice>(prices: T[], removed: string): T | null {
  const rest = prices.filter((p) => p.currency !== removed.toUpperCase());
  return rest.find((p) => p.currency === "USD") ?? [...rest].sort((a, b) => a.currency.localeCompare(b.currency))[0] ?? null;
}
