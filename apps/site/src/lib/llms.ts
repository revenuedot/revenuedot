// The llms files come from the revenuedot/docs repo (its llms.txt is canonical), with links pointed at revenuedot.app.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { docsDir, rewriteLlmsText } from "./docs-source.mjs";

export const llmsFile = (rel: string) => rewriteLlmsText(readFileSync(path.join(docsDir(), rel), "utf8"));
export const llmsShards = () => readdirSync(path.join(docsDir(), "llms")).filter((f) => f.endsWith(".txt")).map((f) => f.replace(/\.txt$/, ""));
export const textResponse = (body: string) => new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
