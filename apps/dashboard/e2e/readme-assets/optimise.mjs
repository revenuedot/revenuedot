// Quantised 8-bit PNGs (sharp's palette mode) from the 2x captures, each well under 600 KB.
import { createRequire } from "node:module";
import { readdirSync, mkdirSync, statSync } from "node:fs";
const require = createRequire(new URL("../../../site/package.json", import.meta.url));
const sharp = require("sharp");
const src = process.argv[2], out = process.argv[3];
mkdirSync(out, { recursive: true });
for (const f of readdirSync(src).filter((x) => x.endsWith(".png")).sort()) {
  const img = sharp(`${src}/${f}`);
  const meta = await img.metadata();
  await img.png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 }).toFile(`${out}/${f}`);
  console.log(f, `${meta.width}x${meta.height}`, Math.round(statSync(`${out}/${f}`).size / 1024) + " KB");
}
