import { Fragment, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { applyTheme, applyTint, getDisplay, setDisplay, type Display } from "../lib/prefs";
import type { Me } from "./Shell";

/**
 * Keeps the display preferences (lib/prefs.ts) in step with the signed-in person's account: theme, tint, first day of
 * the week and display currency with its rate (GET /auth/fx). It never asks /auth/me itself (signed-out pages would log
 * a 401); it follows whatever a page loaded into the ["me"] query. When the currency, its rate or the week start change,
 * the pages below remount so every amount and calendar is drawn again.
 */
export function PrefsProvider({ children }: { children: ReactNode }) {
  const me = useQuery<Me>({ queryKey: ["me"], queryFn: () => api<Me>("/auth/me"), enabled: false, retry: false });
  const prefs = me.data?.user.preferences;
  const currency = prefs?.display_currency ?? null;
  const fx = useQuery({
    queryKey: ["fx", currency], enabled: !!currency && currency !== "USD", staleTime: 3_600_000, retry: 1,
    queryFn: () => api<{ currency: string; rate: number; date: string }>(`/auth/fx?currency=${encodeURIComponent(currency!)}`),
  });
  useEffect(() => { if (prefs) applyTheme(prefs.theme); }, [prefs?.theme]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (prefs) applyTint(prefs.tint); }, [prefs?.tint]); // eslint-disable-line react-hooks/exhaustive-deps

  let display: Display = getDisplay();
  if (prefs) {
    const next: Display | null = prefs.display_currency === "USD"
      ? { currency: "USD", rate: 1, rateDate: null, weekStart: prefs.week_start }
      : fx.data?.currency === prefs.display_currency ? { currency: fx.data.currency, rate: fx.data.rate, rateDate: fx.data.date, weekStart: prefs.week_start }
        // The rate is on its way: keep the last one for this currency, but take the new week start now.
        : display.currency === prefs.display_currency ? { ...display, weekStart: prefs.week_start } : null;
    if (next && (next.currency !== display.currency || next.rate !== display.rate || next.weekStart !== display.weekStart || next.rateDate !== display.rateDate)) {
      setDisplay(next);
      display = next;
    }
  }
  return <Fragment key={`${display.currency}|${display.rate}|${display.weekStart}`}>{children}</Fragment>;
}
