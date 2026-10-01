import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DataTable, Panel, Segmented, useToast } from "../../components/ui";
import { api, fmt } from "../../lib/api";
import { errMsg } from "../setup/data";
import { v2 } from "./data";

/**
 * Apple Search Ads campaign report on the integration page (prd/integrations/PRD.md, "Apple Search Ads"): customers
 * first seen in the period by campaign (from the AdServices attribution), paying customers and revenue to date, with
 * campaign names once the API user's credentials have loaded them.
 */

interface Report {
  campaigns: { campaign_id: string; name: string | null; customers: number; paying_customers: number; revenue: number; revenue_per_customer: number }[];
  names_loaded: number; last_sync_at: number | null; last_sync_error: string | null;
}

export function AppleAdsPanel({ pid, canSync }: { pid: string; canSync: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [range, setRange] = useState<"28d" | "90d" | "12m">("90d");
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["apple_ads_report", pid, range], queryFn: () => api<Report>(`${v2(pid)}/ads/apple_search_ads/report?range=${range}`) });
  const sync = async () => {
    setBusy(true);
    try { const r = await api<{ campaigns: number }>(`${v2(pid)}/ads/apple_search_ads/sync`, { method: "POST" }); toast(`Loaded ${r.campaigns} campaign name${r.campaigns === 1 ? "" : "s"}.`); }
    catch (e) { toast(errMsg(e)); } finally { setBusy(false); await qc.invalidateQueries({ queryKey: ["apple_ads_report", pid] }); }
  };
  return (
    <Panel title="Revenue by campaign" flush link={<span className="hrow">
      <Segmented label="Period" value={range} onChange={setRange} options={[{ value: "28d", label: "28D" }, { value: "90d", label: "90D" }, { value: "12m", label: "12M" }]} />
      {canSync && <button type="button" className="btn btn-line" disabled={busy} onClick={sync}>{busy ? "Loading…" : "Load campaign names"}</button>}
    </span>}>
      <div className="pb section-sub" style={{ paddingBottom: 0 }}>
        Customers first seen in the period whose install Apple attributed to a campaign (AdServices), with their production revenue to date.
        {q.data?.last_sync_error ? <span className="down"> Last name load failed: {q.data.last_sync_error}</span> : q.data?.last_sync_at ? ` Names loaded ${fmt.ago(q.data.last_sync_at)}.` : ""}
      </div>
      {q.isError && <div className="pb"><div className="banner err" role="alert">{errMsg(q.error)}</div></div>}
      <DataTable rows={q.data?.campaigns ?? []} rowKey={(r) => r.campaign_id}
        columns={[
          { key: "c", header: "Campaign", render: (r) => <>{r.name ?? <span className="mono">{r.campaign_id}</span>}{r.name && <span className="cellsub mono">{r.campaign_id}</span>}</> },
          { key: "n", header: "Customers", align: "right", className: "num", render: (r) => fmt.int(r.customers) },
          { key: "p", header: "Paying", align: "right", className: "num", render: (r) => fmt.int(r.paying_customers) },
          { key: "r", header: "Revenue", align: "right", className: "num", render: (r) => fmt.usd(r.revenue, true) },
          { key: "rpc", header: "Per customer", align: "right", className: "num", render: (r) => fmt.usd(r.revenue_per_customer, true) },
        ]}
        empty={<div className="pb section-sub">{q.isLoading ? "Loading…" : "No customers from Apple Search Ads in this period. Turn on AdServices attribution in the SDK (enableAdServicesAttributionTokenCollection) to collect it."}</div>} />
    </Panel>
  );
}
