/** Shared data hooks and types for the paywall pages (list, gallery, editor, AI). */
import { useQuery } from "@tanstack/react-query";
import type { PaywallDoc } from "@revenuedot/core";
import { api, type List } from "../../lib/api";
import { listAll, v2, type Offering } from "../catalog/lib";

export interface Version { revision: number | null; components_config: Record<string, unknown> | null; components_localizations: Record<string, Record<string, unknown>>; default_locale: string | null }
export interface Paywall {
  object: "paywall"; id: string; name: string | null; offering_id: string | null; created_at: number; published_at: number | null; revision: number;
  offering?: Offering | null; components?: { published: Version | null; draft: Version | null };
}
export interface TemplateMeta { id: string; name: string; description: string; screens: number; purchase_method: "in_app" | "web"; packages: number; tiers: number; tags: string[]; evidence: string }
export interface AiStatus { available: boolean; provider: string | null; model: string | null; max_prompt_length: number }
export interface Generation { name: string | null; components_config: PaywallDoc["components_config"]; components_localizations: PaywallDoc["components_localizations"]; default_locale: string; fixes: string[]; warnings: { path: string; message: string }[]; provider: string; model: string }
export interface MediaAsset { id: string; object_name: string; original_name: string; original_width: number | null; original_height: number | null; asset_base_url: string }

export const status = (p: Paywall): [string, "up" | "gold" | "muted"] =>
  p.published_at ? (p.components?.draft ? ["Published, with changes", "gold"] : ["Published", "up"]) : ["Not published", "muted"];

export const usePaywalls = (pid: string) => useQuery({
  queryKey: ["paywalls", pid], enabled: !!pid,
  queryFn: async () => {
    const list = await api<List<Paywall>>(`${v2(pid)}/paywalls?limit=100&expand=items.offering`);
    // The list has no components; fetch them to tell "published with changes" apart.
    return Promise.all(list.items.map((p) => api<Paywall>(`${v2(pid)}/paywalls/${p.id}?expand=components&expand=offering`)));
  },
});
export const useOfferingsWithPackages = (pid: string) => useQuery({
  queryKey: ["paywall-offerings", pid], enabled: !!pid,
  queryFn: async () => (await listAll<Offering>(`${v2(pid)}/offerings?expand=items.package`)).filter((o) => o.state !== "inactive"),
});
export const useTemplates = (pid: string) => useQuery({
  queryKey: ["paywall-templates", pid], enabled: !!pid, staleTime: Infinity,
  queryFn: () => api<{ items: TemplateMeta[]; icon_base_url: string }>(`${v2(pid)}/paywall_templates`),
});
export const useAi = (pid: string) => useQuery({ queryKey: ["paywall-ai", pid], enabled: !!pid, staleTime: 60_000, queryFn: () => api<AiStatus>(`${v2(pid)}/paywalls/ai`) });
export const useMedia = (pid: string) => useQuery({ queryKey: ["paywall-media", pid], enabled: !!pid, queryFn: () => listAll<MediaAsset>(`${v2(pid)}/media_assets`) });

/** Package identifiers of an offering, in display order. */
export const packageIds = (o: Offering | null | undefined) => (o?.packages?.items ?? []).slice().sort((a, b) => a.position - b.position).map((p) => ({ id: p.lookup_key, label: p.display_name }));

/** Reads a file as base64 (without the data: prefix). */
export const fileBase64 = (file: File) => new Promise<string>((ok, no) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(",")[1] ?? "");
  r.onerror = () => no(r.error);
  r.readAsDataURL(file);
});
export async function uploadImage(pid: string, file: File): Promise<MediaAsset> {
  if (file.size > 2_000_000) throw new Error("Images must be under 2 MB.");
  return api<MediaAsset>(`${v2(pid)}/media_assets`, { method: "POST", json: { filename: file.name, content_type: file.type || "image/png", file_data_base64: await fileBase64(file) } });
}

/** The document the editor edits, from a paywall's draft (or published version). */
export function docOf(p: Paywall): PaywallDoc | null {
  const v = p.components?.draft ?? p.components?.published;
  if (!v?.components_config) return null;
  return {
    components_config: v.components_config as PaywallDoc["components_config"],
    components_localizations: (v.components_localizations ?? {}) as PaywallDoc["components_localizations"],
    default_locale: v.default_locale ?? "en_US",
  };
}
