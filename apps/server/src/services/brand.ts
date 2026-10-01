import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema, type DB } from "@revenuedot/db";

/**
 * Brand (prd/project-settings §2): colour and gradient presets for every colour picker, and the SDK's
 * `ui_config.app.colors`, where a paywall colour `{ "type": "alias", "value": "<key>" }` is resolved. The iOS SDK reads
 * the alias's dark side in dark mode and fails without one, so dark always defaults to light.
 */

const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const Hex = z.string().trim().regex(HEX, "must be a #RRGGBB or #RRGGBBAA colour");
const Key = z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/, "must use a-z, 0-9 and _ only");
const Point = z.object({ color: Hex, percent: z.number().int().min(0).max(100) });

export const ColorPreset = z.object({ key: Key, name: z.string().trim().min(1).max(60), light: Hex, dark: Hex.nullable().optional() });
export const GradientPreset = z.object({
  key: Key, name: z.string().trim().min(1).max(60), type: z.enum(["linear", "radial"]), degrees: z.number().int().min(0).max(360).optional(),
  points: z.array(Point).min(2).max(10), dark_points: z.array(Point).min(2).max(10).nullable().optional(),
});
export const BrandIn = z.object({
  color_presets: z.array(ColorPreset).max(50).optional(),
  gradient_presets: z.array(GradientPreset).max(50).optional(),
}).superRefine((b, ctx) => {
  const seen = new Set<string>();
  for (const [list, items] of [["color_presets", b.color_presets ?? []], ["gradient_presets", b.gradient_presets ?? []]] as const) {
    items.forEach((p, i) => {
      if (seen.has(p.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [list, i, "key"], message: `the key ${p.key} is used twice` });
      seen.add(p.key);
    });
  }
});
export type Brand = { color_presets: z.infer<typeof ColorPreset>[]; gradient_presets: z.infer<typeof GradientPreset>[] };

/** Lower-case hex with alpha, as the SDKs and our renderer expect. */
const norm = (h: string) => (h.length === 7 ? `${h}ff` : h).toLowerCase();

export function brandOf(raw: unknown): Brand {
  const r = BrandIn.safeParse(raw ?? {});
  const b = r.success ? r.data : {};
  return {
    color_presets: (b.color_presets ?? []).map((p) => ({ key: p.key, name: p.name, light: norm(p.light), dark: p.dark ? norm(p.dark) : null })),
    gradient_presets: (b.gradient_presets ?? []).map((g) => ({
      key: g.key, name: g.name, type: g.type, ...(g.type === "linear" ? { degrees: g.degrees ?? 180 } : {}),
      points: g.points.map((p) => ({ color: norm(p.color), percent: p.percent })),
      dark_points: g.dark_points ? g.dark_points.map((p) => ({ color: norm(p.color), percent: p.percent })) : null,
    })),
  };
}

/** `ui_config.app.colors`: every preset as a colour scheme with light and dark. */
export function brandColors(b: Brand): Record<string, { light: Record<string, unknown>; dark: Record<string, unknown> }> {
  const out: Record<string, { light: Record<string, unknown>; dark: Record<string, unknown> }> = {};
  for (const c of b.color_presets) out[c.key] = { light: { type: "hex", value: c.light }, dark: { type: "hex", value: c.dark ?? c.light } };
  for (const g of b.gradient_presets) {
    const info = (points: { color: string; percent: number }[]) => (g.type === "linear" ? { type: "linear", degrees: g.degrees ?? 180, points } : { type: "radial", points });
    out[g.key] = { light: info(g.points), dark: info(g.dark_points ?? g.points) };
  }
  return out;
}

export async function projectBrand(db: DB, projectId: string): Promise<Brand> {
  const [p] = await db.select({ brand: schema.projects.brand }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  return brandOf(p?.brand);
}
