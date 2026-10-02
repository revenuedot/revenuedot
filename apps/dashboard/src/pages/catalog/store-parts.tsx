/**
 * Store prices and status on the catalog pages (prd/catalog/PRD.md "Store prices and status"): the price label RevenueCat
 * leads with ("$89.99/year" over the identifier), the store status tag, each app's price source line with Refresh, and
 * the "New …" menu with Create from scratch and Create with AI.
 */
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, fmt } from "../../lib/api";
import { useMe } from "../../components/Shell";
import { Menu, Tag, useToast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useAiStatus } from "../ai/data";
import { catalogKey, errMsg, priceAndPeriod, storeStatus, v2, type App, type PriceSync, type Product } from "./lib";
import "./store.css";

/** Whether the signed-in member may change the catalog (Viewers read only; the API decides for custom roles). */
export function useCanEdit(pid: string): boolean {
  const me = useMe();
  const role = me.data?.projects.find((p) => p.id === pid)?.role;
  return role !== undefined && role !== "viewer";
}

/** RevenueCat's product cell: the price and period when the store or Test Store price is known, the identifier under it. */
export function PriceCell({ p, to, archived }: { p: Product; to?: string; archived?: boolean }) {
  const price = priceAndPeriod(p);
  const name = p.display_name && p.display_name !== p.store_identifier ? p.display_name : null;
  const main = price ?? name ?? p.store_identifier;
  const sub = price ? (name ? `${p.store_identifier} · ${name}` : p.store_identifier) : name ? p.store_identifier : null;
  return (
    <span className="cat-prodcell">
      <span className="cat-cell">
        {to ? <Link className={`cat-lnk cat-t${price ? " cat-price-t" : ""}`} to={to} onClick={(e) => e.stopPropagation()}>{main}</Link> : <span className={`cat-t${price ? " cat-price-t" : ""}`}>{main}</span>}
        {sub && <span className="cat-s" title={sub}>{sub}</span>}
      </span>
      {archived && <Tag>Archived</Tag>}
    </span>
  );
}

/** The store's status: "Approved" (App Store review), "Active" (Play base plan) …; a dash when it was never read. */
export function StoreStatus({ p, app }: { p: Product; app?: App }) {
  const s = storeStatus(p.store_details?.status);
  if (s) return <Tag tone={s.tone}>{s.label}</Tag>;
  if (app?.type === "test_store") return <span className="subtle" title="Test Store products need no store review.">Test Store</span>;
  return <span className="subtle" title={app && ["app_store", "mac_app_store", "play_store"].includes(app.type) ? "Not read from the store yet. Refresh prices to read it." : "This store reports no status."}>—</span>;
}

/** Where an app's prices come from, when they were read, and Refresh; or why they cannot be read. */
export function PriceSource({ pid, app, sync, canEdit }: { pid: string; app: App; sync: PriceSync | undefined; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!sync) return null;
  const store = app.type === "play_store" ? "Google Play" : "App Store Connect";
  const refresh = async () => {
    setBusy(true);
    try {
      const r = await api<{ items: unknown[] }>(`${v2(pid)}/apps/${app.id}/store_prices/actions/refresh`, { method: "POST" });
      toast(`Read ${r.items.length} products from ${store}`);
    } catch (e) { toast(errMsg(e)); }
    await qc.invalidateQueries({ queryKey: catalogKey(pid) });
    setBusy(false);
  };
  let text: ReactNode;
  if (!sync.can_read_prices) {
    text = <><Icon name="warn" /><span>{sync.reason} <Link className="cat-lnk" to={`/projects/${pid}/apps/${app.id}`}>App settings</Link></span></>;
  } else if (sync.status === "never") {
    text = <span>Prices and status have not been read from {store} yet.</span>;
  } else if (sync.status === "failing") {
    text = <><Icon name="warn" /><span className="cat-err">The last read from {store} failed {fmt.ago(sync.refreshed_at)}: {sync.error}</span></>;
  } else {
    text = <span>Prices and status from {store} · read {fmt.ago(sync.refreshed_at)}</span>;
  }
  return (
    <div className="cat-pricesrc" data-testid={`price-source-${app.id}`}>
      {text}
      {sync.can_read_prices && canEdit && (
        <button type="button" className="btn btn-ghost" onClick={refresh} disabled={busy} aria-label={`Refresh prices of ${app.name}`}><Icon name="refresh" />{busy ? "Reading…" : "Refresh prices"}</button>
      )}
    </div>
  );
}

/** "New product" / "New offering": Create from scratch, or Create with AI (disabled with the reason when it cannot write). */
export function NewMenu({ pid, what, onScratch, onAi, variant = "dark" }: { pid: string; what: "product" | "offering"; onScratch: () => void; onAi: () => void; variant?: "dark" | "line" }) {
  const ai = useAiStatus(pid);
  const s = ai.data;
  const why = !s ? "Loading…" : !s.configured ? "RevenueDot AI is off on this server" : !s.available ? s.reason ?? "RevenueDot AI is off in this project" : !s.can_write ? s.reason ?? "RevenueDot AI is read only here" : null;
  return (
    <Menu label={`New ${what}`} text={`New ${what}`} variant={variant} items={[
      { label: "Create from scratch", icon: "plus", onSelect: onScratch },
      { label: "Create with AI", icon: "spark", onSelect: onAi, disabled: !!why, hint: why ?? undefined },
    ]} />
  );
}
