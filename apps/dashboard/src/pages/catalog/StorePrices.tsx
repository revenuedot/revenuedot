/**
 * "Prices by territory" on an App Store or Google Play product's page (prd/catalog/PRD.md "Store prices and status"):
 * every territory's price from the last read, base territory first, with where it came from, Refresh, and a link to the
 * product editor with this product chosen.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Panel } from "../../components/ui";
import { priceLabel, useStorePrices, type App, type Product } from "./lib";
import { PriceSource, useCanEdit } from "./store-parts";

const FIRST = 12;

export function StorePricesPanel({ pid, app, product }: { pid: string; app: App; product: Product }) {
  const prices = useStorePrices(pid);
  const canEdit = useCanEdit(pid);
  const [all, setAll] = useState(false);
  const listing = prices.data?.items.find((l) => l.app_id === app.id && l.store_identifier === product.store_identifier);
  const sync = prices.data?.apps.find((a) => a.app_id === app.id);
  const rows = listing ? [...listing.prices].sort((a, b) => (a.territory === listing.price?.territory ? -1 : b.territory === listing.price?.territory ? 1 : a.territory.localeCompare(b.territory))) : [];
  const shown = all ? rows : rows.slice(0, FIRST);
  const editor = `/projects/${pid}/product-catalog/product-editor?app=${encodeURIComponent(app.id)}&products=${encodeURIComponent(product.store_identifier)}`;
  return (
    <Panel flush title="Prices by territory" link={listing?.editable && sync?.can_read_prices ? <Link className="btn btn-ghost" to={editor}>Edit in Product editor →</Link> : undefined}>
      <PriceSource pid={pid} app={app} sync={sync} canEdit={canEdit} />
      {prices.isLoading ? <div className="pb cat-note">Loading prices…</div>
        : !listing ? (
          sync?.can_read_prices && sync.status !== "never"
            ? <div className="pb cat-note">{product.store_identifier} is not in {app.type === "play_store" ? "Google Play" : "App Store Connect"} for this app. Check the identifier, or create it there.</div>
            : null
        ) : !rows.length ? <div className="pb cat-note">This product has no price in the store yet.{listing.note ? ` ${listing.note}` : ""}</div> : (
          <>
            <div className="tbl"><table className="cat-terr" aria-label={`Prices of ${product.store_identifier} by territory`}>
              <thead><tr><th>Territory</th><th>Currency</th><th className="amt">Price</th></tr></thead>
              <tbody>{shown.map((r) => (
                <tr key={r.territory}>
                  <td className="mono">{r.territory}{r.territory === listing.price?.territory && <span className="subtle"> · base</span>}</td>
                  <td className="mono">{r.currency}</td>
                  <td className="amt mono">{priceLabel(r)}</td>
                </tr>
              ))}</tbody>
            </table></div>
            {rows.length > FIRST && <div className="pb"><button type="button" className="btn btn-ghost" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${rows.length} territories`}</button></div>}
          </>
        )}
    </Panel>
  );
}
