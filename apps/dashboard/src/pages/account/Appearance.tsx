import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DateField } from "../../components/DateField";
import { useMe, type Me, type Preferences } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { Tag, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { CURRENCIES, PAGE, WEEKDAYS, applyTheme, applyTint, contrast, formatUsd, tintTokens, type Theme } from "../../lib/prefs";
import { AccountLayout, Row, Section, errText } from "./AccountLayout";

/** Saves preferences on the account (POST /auth/me) and updates the cached person, which PrefsProvider applies. */
function useSavePrefs() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (patch: Partial<Preferences>, done: string) => {
    try {
      const r = await api<{ user: Me["user"] }>("/auth/me", { method: "POST", json: patch });
      qc.setQueryData<Me>(["me"], (m) => (m ? { ...m, user: { ...m.user, ...r.user } } : m));
      toast(done);
      return true;
    } catch (e) { toast(errText(e)); return false; }
  };
}

const THEMES: { value: Theme; label: string; icon: string; colors: [string, string, string] }[] = [
  { value: "system", label: "System", icon: "monitor", colors: ["#FAFAFA", "#0D0D0D", "#FFFFFF"] },
  { value: "light", label: "Light", icon: "sun", colors: ["#FAFAFA", "#FFFFFF", "#E5E5E5"] },
  { value: "dark", label: "Dark", icon: "moon", colors: ["#0D0D0D", "#0A0A0A", "#262626"] },
];
/** The gold of the logo, then the five chart series colours of design/tokens.css. */
const TINTS: { value: string | null; label: string; color: string }[] = [
  { value: null, label: "Gold (default)", color: "#F7B500" }, { value: "#2A78D6", label: "Blue", color: "#2A78D6" }, { value: "#1BAF7A", label: "Green", color: "#1BAF7A" },
  { value: "#4A3AA7", label: "Violet", color: "#4A3AA7" }, { value: "#EB6834", label: "Orange", color: "#EB6834" }, { value: "#E87BA4", label: "Pink", color: "#E87BA4" },
];

/** Interface (RevenueCat: Settings → Interface): theme and a tint for the accent, saved on the account. */
export function AccountInterfacePage() {
  const me = useMe();
  const save = useSavePrefs();
  const p = me.data?.user.preferences;
  const [custom, setCustom] = useState<string | null>(null);
  const setTheme = async (t: Theme) => { applyTheme(t); await save({ theme: t }, `Theme: ${t === "system" ? "follows your system" : t}.`); };
  const setTint = async (t: string | null) => { applyTint(t); await save({ tint: t }, t ? `Tint ${t} saved.` : "Tint reset to the default gold."); };
  const tint = p?.tint ?? null;
  const tokens = tint ? tintTokens(tint) : null;
  const inkLight = tokens?.light.ink ?? "#8A5A00", inkDark = tokens?.dark.ink ?? "#FFD35C";
  return (
    <AccountLayout section="interface">
      {p && <>
        <Section title="Theme" id="theme">
          <Row label="Appearance" help="System follows your computer's light or dark setting. Saved on your account, so it follows you to other browsers.">
            <div className="theme-opts" role="radiogroup" aria-label="Theme">
              {THEMES.map((t) => (
                <button key={t.value} type="button" role="radio" aria-checked={p.theme === t.value} className="theme-opt" onClick={() => setTheme(t.value)}>
                  <span className="sw-prev" aria-hidden><i style={{ background: t.colors[0], borderRight: `1px solid ${t.colors[2]}` }} />{t.value === "system" ? <i style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}><span style={{ background: "#FFFFFF" }} /><span style={{ background: "#0A0A0A" }} /></i> : <i style={{ background: t.colors[1] }} />}</span>
                  <b><Icon name={t.icon} />{t.label}</b>
                </button>
              ))}
            </div>
          </Row>
        </Section>
        <Section title="Tint colour" id="tint" sub="Replaces the gold accent: the live dot, focus rings, the current period in charts and highlighted text. Pages stay white and grey (dark in dark mode).">
          <Row label="Accent" help="Text in the accent is darkened or lightened until it reads at 4.5:1 or better on both themes.">
            <div className="tints" role="radiogroup" aria-label="Tint colour">
              {TINTS.map((t) => (
                <button key={t.label} type="button" role="radio" aria-checked={tint === t.value} className="tint" title={t.label} aria-label={t.label} onClick={() => setTint(t.value)}><span style={{ background: t.color }} /></button>
              ))}
              <label className={`btn btn-line tint-custom${tint && !TINTS.some((t) => t.value === tint) ? " on" : ""}`}>
                <input type="color" aria-label="Custom tint colour" value={custom ?? tint ?? "#F7B500"} onChange={(e) => setCustom(e.target.value)} />
                Custom
              </label>
              {custom && custom.toUpperCase() !== tint && <button type="button" className="btn btn-dark" onClick={() => setTint(custom.toUpperCase())}>Use {custom.toUpperCase()}</button>}
              <button type="button" className="btn btn-ghost" disabled={!tint} onClick={() => { setCustom(null); void setTint(null); }}>Reset</button>
            </div>
            <div className="tint-preview" data-tint={tint ?? "default"}>
              <span className="acct-pill"><span className="live" /> Live</span>
              <Tag tone="gold">Current</Tag>
              <span className="ink">Accent text</span>
              <span className="ring">Focus ring</span>
            </div>
            <p className="acct-note">
              Accent text contrast: <span className={`ratio${contrast(inkLight, PAGE.light) >= 4.5 ? " ok" : ""}`} data-ratio-light>{contrast(inkLight, PAGE.light).toFixed(1)}:1 light</span>
              {" · "}<span className={`ratio${contrast(inkDark, PAGE.dark) >= 4.5 ? " ok" : ""}`} data-ratio-dark>{contrast(inkDark, PAGE.dark).toFixed(1)}:1 dark</span>
              {tint ? ` · accent ${tint}` : " · the default gold"}
            </p>
          </Row>
        </Section>
      </>}
    </AccountLayout>
  );
}

/** Date and region (RevenueCat: Settings → Date and region): first day of the week and the display currency. */
export function AccountDateRegionPage() {
  const me = useMe();
  const save = useSavePrefs();
  const p = me.data?.user.preferences;
  const [sample, setSample] = useState(() => new Date().toISOString().slice(0, 10));
  const fx = useQuery({ queryKey: ["fx", p?.display_currency], enabled: !!p && p.display_currency !== "USD", staleTime: 3_600_000, queryFn: () => api<{ currency: string; rate: number; date: string; source: string }>(`/auth/fx?currency=${p!.display_currency}`) });
  const cur = p?.display_currency ?? "USD";
  // Until the rate is known the example stays in USD, like every other amount.
  const d = cur === "USD" || !fx.data ? { currency: "USD", rate: 1, rateDate: null, weekStart: p?.week_start ?? 1 } : { currency: cur, rate: fx.data.rate, rateDate: fx.data.date, weekStart: p?.week_start ?? 1 };
  return (
    <AccountLayout section="date-and-region">
      {p && <>
        <Section title="Calendar" id="calendar">
          <Row label="Start week on" htmlFor="week-start" help="Charts with weekly buckets, the date pickers and your weekly summary email start their weeks on this day.">
            <select id="week-start" className="select" value={p.week_start} onChange={(e) => save({ week_start: Number(e.target.value) }, `Weeks start on ${WEEKDAYS[Number(e.target.value)]}.`)}>
              {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}
            </select>
            <div className="week-prev" aria-hidden>{Array.from({ length: 7 }, (_, i) => WEEKDAYS[(p.week_start + i) % 7]!).map((w, i) => <span key={w} className={i === 0 ? "first" : undefined}>{w.slice(0, 3)}</span>)}</div>
            <div className="acct-inline"><span className="acct-note">Try it:</span><DateField label="Sample date" value={sample} onChange={setSample} /></div>
          </Row>
        </Section>
        <Section title="Currency" id="currency">
          <Row label="Display currency" htmlFor="display-currency" help="Every amount in the dashboard is shown in this currency. Charts convert each day at that day's rate; other figures use the latest rate. The API and Cloud bills stay in USD.">
            <select id="display-currency" className="select" value={cur} onChange={(e) => save({ display_currency: e.target.value }, `Amounts now show in ${e.target.value}.`)}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
            </select>
            {cur !== "USD" && (
              <p className="fx-line" data-fx>{fx.isError ? "The exchange rate could not be loaded; amounts stay in USD until it can." : fx.data ? `1 USD = ${fx.data.rate} ${cur} · ${fx.data.source === "ecb" ? "European Central Bank" : "currency-api"} reference rate of ${fx.data.date}` : "Loading the exchange rate…"}</p>
            )}
            <p className="acct-note" data-sample-amount>Example: $1,234.56 shows as <b>{formatUsd(1234.56, true, d)}</b>.</p>
          </Row>
        </Section>
      </>}
    </AccountLayout>
  );
}
