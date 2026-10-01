// Real partner and platform logos in src/assets/logos (SVG or PNG), by file name.
const files = import.meta.glob<string>("../assets/logos/*.{svg,png}", { eager: true, query: "?url", import: "default" });
const index = new Map(Object.entries(files).map(([k, v]) => [k.split("/").pop()!, v]));
export function logo(file: string): string {
  const url = index.get(file) ?? index.get(file.replace(/\.svg$/, ".png"));
  if (!url) throw new Error(`Missing logo ${file}. Known: ${[...index.keys()].join(", ")}`);
  return url;
}
export const hasLogo = (file: string) => index.has(file) || index.has(file.replace(/\.svg$/, ".png"));
