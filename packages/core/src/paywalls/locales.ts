/**
 * The words the SDKs put into price and period variables (`{{ product.periodly }}`, `{{ product.price_per_period }}`,
 * `%d days`), sent in `ui_config.localizations` next to the paywall. Twelve languages; any other locale gets English.
 * Keys follow the SDK's `VariableLocalizationKey` (purchases-ios RevenueCatUI/Templates/V2/Variables).
 */

type Words = {
  day: string; week: string; month: string; year: string;
  daily: string; weekly: string; monthly: string; yearly: string; annual: string; annually: string;
  short: { day: string; week: string; month: string; year: string };
  free: string;
  /** Plural forms: [one, other] or [one, few, many, other]. %d is the number. */
  days: string[]; weeks: string[]; months: string[]; years: string[];
  /** Short counts: "%dd". */
  daysShort: string; weeksShort: string; monthsShort: string; yearsShort: string;
};

const W: Record<string, Words> = {
  en: { day: "day", week: "week", month: "month", year: "year", daily: "daily", weekly: "weekly", monthly: "monthly", yearly: "yearly", annual: "annual", annually: "annually", short: { day: "day", week: "wk", month: "mo", year: "yr" }, free: "free", days: ["%d day", "%d days"], weeks: ["%d week", "%d weeks"], months: ["%d month", "%d months"], years: ["%d year", "%d years"], daysShort: "%dd", weeksShort: "%dwk", monthsShort: "%dmo", yearsShort: "%dyr" },
  es: { day: "día", week: "semana", month: "mes", year: "año", daily: "diario", weekly: "semanal", monthly: "mensual", yearly: "anual", annual: "anual", annually: "anualmente", short: { day: "día", week: "sem", month: "mes", year: "año" }, free: "gratis", days: ["%d día", "%d días"], weeks: ["%d semana", "%d semanas"], months: ["%d mes", "%d meses"], years: ["%d año", "%d años"], daysShort: "%d d", weeksShort: "%d sem", monthsShort: "%d m", yearsShort: "%d a" },
  fr: { day: "jour", week: "semaine", month: "mois", year: "an", daily: "quotidien", weekly: "hebdomadaire", monthly: "mensuel", yearly: "annuel", annual: "annuel", annually: "annuellement", short: { day: "j", week: "sem", month: "mois", year: "an" }, free: "gratuit", days: ["%d jour", "%d jours"], weeks: ["%d semaine", "%d semaines"], months: ["%d mois", "%d mois"], years: ["%d an", "%d ans"], daysShort: "%d j", weeksShort: "%d sem", monthsShort: "%d mois", yearsShort: "%d an" },
  de: { day: "Tag", week: "Woche", month: "Monat", year: "Jahr", daily: "täglich", weekly: "wöchentlich", monthly: "monatlich", yearly: "jährlich", annual: "jährlich", annually: "jährlich", short: { day: "Tg", week: "Wo", month: "Mon", year: "J" }, free: "kostenlos", days: ["%d Tag", "%d Tage"], weeks: ["%d Woche", "%d Wochen"], months: ["%d Monat", "%d Monate"], years: ["%d Jahr", "%d Jahre"], daysShort: "%d T", weeksShort: "%d W", monthsShort: "%d M", yearsShort: "%d J" },
  it: { day: "giorno", week: "settimana", month: "mese", year: "anno", daily: "giornaliero", weekly: "settimanale", monthly: "mensile", yearly: "annuale", annual: "annuale", annually: "annualmente", short: { day: "g", week: "sett", month: "mese", year: "anno" }, free: "gratis", days: ["%d giorno", "%d giorni"], weeks: ["%d settimana", "%d settimane"], months: ["%d mese", "%d mesi"], years: ["%d anno", "%d anni"], daysShort: "%d g", weeksShort: "%d sett", monthsShort: "%d m", yearsShort: "%d a" },
  pt: { day: "dia", week: "semana", month: "mês", year: "ano", daily: "diário", weekly: "semanal", monthly: "mensal", yearly: "anual", annual: "anual", annually: "anualmente", short: { day: "dia", week: "sem", month: "mês", year: "ano" }, free: "grátis", days: ["%d dia", "%d dias"], weeks: ["%d semana", "%d semanas"], months: ["%d mês", "%d meses"], years: ["%d ano", "%d anos"], daysShort: "%d d", weeksShort: "%d sem", monthsShort: "%d m", yearsShort: "%d a" },
  nl: { day: "dag", week: "week", month: "maand", year: "jaar", daily: "dagelijks", weekly: "wekelijks", monthly: "maandelijks", yearly: "jaarlijks", annual: "jaarlijks", annually: "jaarlijks", short: { day: "dag", week: "wk", month: "mnd", year: "jr" }, free: "gratis", days: ["%d dag", "%d dagen"], weeks: ["%d week", "%d weken"], months: ["%d maand", "%d maanden"], years: ["%d jaar", "%d jaar"], daysShort: "%d d", weeksShort: "%d wk", monthsShort: "%d mnd", yearsShort: "%d jr" },
  ru: { day: "день", week: "неделя", month: "месяц", year: "год", daily: "ежедневно", weekly: "еженедельно", monthly: "ежемесячно", yearly: "ежегодно", annual: "годовой", annually: "ежегодно", short: { day: "дн", week: "нед", month: "мес", year: "г" }, free: "бесплатно", days: ["%d день", "%d дня", "%d дней", "%d дня"], weeks: ["%d неделя", "%d недели", "%d недель", "%d недели"], months: ["%d месяц", "%d месяца", "%d месяцев", "%d месяца"], years: ["%d год", "%d года", "%d лет", "%d года"], daysShort: "%d дн", weeksShort: "%d нед", monthsShort: "%d мес", yearsShort: "%d г" },
  ja: { day: "日", week: "週", month: "月", year: "年", daily: "毎日", weekly: "毎週", monthly: "毎月", yearly: "毎年", annual: "年間", annually: "毎年", short: { day: "日", week: "週", month: "月", year: "年" }, free: "無料", days: ["%d日間", "%d日間"], weeks: ["%d週間", "%d週間"], months: ["%dか月", "%dか月"], years: ["%d年", "%d年"], daysShort: "%d日", weeksShort: "%d週", monthsShort: "%dか月", yearsShort: "%d年" },
  ko: { day: "일", week: "주", month: "월", year: "년", daily: "매일", weekly: "매주", monthly: "매월", yearly: "매년", annual: "연간", annually: "매년", short: { day: "일", week: "주", month: "월", year: "년" }, free: "무료", days: ["%d일", "%d일"], weeks: ["%d주", "%d주"], months: ["%d개월", "%d개월"], years: ["%d년", "%d년"], daysShort: "%d일", weeksShort: "%d주", monthsShort: "%d개월", yearsShort: "%d년" },
  zh_Hans: { day: "天", week: "周", month: "月", year: "年", daily: "每天", weekly: "每周", monthly: "每月", yearly: "每年", annual: "年度", annually: "每年", short: { day: "天", week: "周", month: "月", year: "年" }, free: "免费", days: ["%d 天", "%d 天"], weeks: ["%d 周", "%d 周"], months: ["%d 个月", "%d 个月"], years: ["%d 年", "%d 年"], daysShort: "%d天", weeksShort: "%d周", monthsShort: "%d月", yearsShort: "%d年" },
  zh_Hant: { day: "天", week: "週", month: "月", year: "年", daily: "每天", weekly: "每週", monthly: "每月", yearly: "每年", annual: "年度", annually: "每年", short: { day: "天", week: "週", month: "月", year: "年" }, free: "免費", days: ["%d 天", "%d 天"], weeks: ["%d 週", "%d 週"], months: ["%d 個月", "%d 個月"], years: ["%d 年", "%d 年"], daysShort: "%d天", weeksShort: "%d週", monthsShort: "%d月", yearsShort: "%d年" },
};

function plural(unit: string, forms: string[]) {
  const [one, few, many, other] = (forms.length >= 4 ? forms : [forms[0], forms[1], forms[1], forms[1]]) as [string, string, string, string];
  return { [`num_${unit}_zero`]: other, [`num_${unit}_one`]: one, [`num_${unit}_two`]: few, [`num_${unit}_few`]: few, [`num_${unit}_many`]: many, [`num_${unit}_other`]: other };
}
function table(w: Words): Record<string, string> {
  return {
    annual: w.annual, annual_short: w.short.year, annually: w.annually, daily: w.daily, day: w.day, day_short: w.short.day, free_price: w.free, month: w.month, month_short: w.short.month, monthly: w.monthly,
    ...plural("day", w.days), ...plural("month", w.months), ...plural("week", w.weeks), ...plural("year", w.years),
    num_days_short: w.daysShort, num_weeks_short: w.weeksShort, num_months_short: w.monthsShort, num_years_short: w.yearsShort,
    percent: "%d%%", week: w.week, week_short: w.short.week, weekly: w.weekly, year: w.year, year_short: w.short.year, yearly: w.yearly,
  };
}

/** The language table for a locale id such as "es_ES", "pt-BR", "zh_Hant_TW" or "de"; English when unknown. */
export function variableWords(locale: string): Record<string, string> {
  const l = locale.replace(/-/g, "_");
  if (/^zh_(Hant|TW|HK|MO)/i.test(l)) return table(W.zh_Hant!);
  if (/^zh/i.test(l)) return table(W.zh_Hans!);
  return table(W[l.split("_")[0]!.toLowerCase()] ?? W.en!);
}
export const VARIABLE_LANGUAGES = Object.keys(W);

/** `ui_config.localizations` for the given locales (always with en_US). */
export function uiLocalizations(locales: Iterable<string>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = { en_US: variableWords("en_US") };
  for (const l of locales) if (!out[l]) out[l] = variableWords(l);
  return out;
}

/** Locales offered in the editor's "Add language" list: id and English name. */
export const PAYWALL_LOCALES: [string, string][] = [
  ["en_US", "English (US)"], ["en_GB", "English (UK)"], ["es_ES", "Spanish (Spain)"], ["es_MX", "Spanish (Mexico)"], ["fr_FR", "French"], ["de_DE", "German"], ["it_IT", "Italian"],
  ["pt_BR", "Portuguese (Brazil)"], ["pt_PT", "Portuguese (Portugal)"], ["nl_NL", "Dutch"], ["ru_RU", "Russian"], ["ja_JP", "Japanese"], ["ko_KR", "Korean"],
  ["zh_Hans", "Chinese (Simplified)"], ["zh_Hant", "Chinese (Traditional)"], ["sv_SE", "Swedish"], ["da_DK", "Danish"], ["nb_NO", "Norwegian"], ["fi_FI", "Finnish"], ["pl_PL", "Polish"],
  ["tr_TR", "Turkish"], ["uk_UA", "Ukrainian"], ["ar_SA", "Arabic"], ["he_IL", "Hebrew"], ["hi_IN", "Hindi"], ["id_ID", "Indonesian"], ["th_TH", "Thai"], ["vi_VN", "Vietnamese"],
];
