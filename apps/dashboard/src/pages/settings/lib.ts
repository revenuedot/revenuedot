/** Brand presets and fonts, shared by the Brand tab and the paywall editor's colour and font pickers (prd/project-settings §2). */
import { useQuery } from "@tanstack/react-query";
import { api, type List } from "../../lib/api";
import { fileBase64 } from "../paywalls/lib";

export interface ColorPreset { key: string; name: string; light: string; dark: string | null }
export interface GradientPoint { color: string; percent: number }
export interface GradientPreset { key: string; name: string; type: "linear" | "radial"; degrees?: number; points: GradientPoint[]; dark_points: GradientPoint[] | null }
export interface Brand { object: "brand"; color_presets: ColorPreset[]; gradient_presets: GradientPreset[] }
export interface Font { object: "font"; id: string; name: string; family_name: string; style: string; weight: number; url: string; font_key: string }

const v2 = (pid: string) => `/v2/projects/${encodeURIComponent(pid)}`;
export const useBrand = (pid: string) => useQuery({ queryKey: ["brand", pid], enabled: !!pid, queryFn: () => api<Brand>(`${v2(pid)}/brand`) });
export const useFonts = (pid: string) => useQuery({ queryKey: ["fonts", pid], enabled: !!pid, queryFn: async () => (await api<List<Font>>(`${v2(pid)}/fonts?limit=100`)).items });
export const saveBrand = (pid: string, b: Partial<Pick<Brand, "color_presets" | "gradient_presets">>) => api<Brand>(`${v2(pid)}/brand`, { method: "POST", json: b });

export async function uploadFont(pid: string, file: File): Promise<Font> {
  if (!/\.(ttf|otf)$/i.test(file.name)) throw new Error("Fonts must be .ttf or .otf files.");
  if (file.size > 5_000_000) throw new Error("Fonts must be under 5 MB.");
  return api<Font>(`${v2(pid)}/fonts`, { method: "POST", json: { filename: file.name, content_type: /\.otf$/i.test(file.name) ? "font/otf" : "font/ttf", file_data_base64: await fileBase64(file) } });
}

/** `#rrggbbaa` → CSS colour. */
export const cssColor = (hex: string) => (hex.length === 9 ? `#${hex.slice(1, 7)}${hex.slice(7)}` : hex);
export const gradientCss = (g: Pick<GradientPreset, "type" | "degrees" | "points">) => {
  const stops = g.points.map((p) => `${cssColor(p.color)} ${p.percent}%`).join(", ");
  return g.type === "linear" ? `linear-gradient(${g.degrees ?? 180}deg, ${stops})` : `radial-gradient(circle, ${stops})`;
};
/** A preset key from its name: "Brand Gold" → "brand_gold". */
export const keyOf = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "color";

const WEIGHTS: Record<number, string> = { 100: "Thin", 200: "Extra light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra bold", 900: "Black" };
/** "Bold", "Regular Italic": a font's weight and style as people say them. */
export const fontStyleName = (f: Pick<Font, "weight" | "style">) => `${WEIGHTS[Math.round((f.weight || 400) / 100) * 100] ?? f.weight}${f.style === "italic" ? " Italic" : ""}`;
