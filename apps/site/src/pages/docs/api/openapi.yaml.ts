// The OpenAPI 3.1 document behind the API reference, served from the docs repo.
import type { APIRoute } from "astro";
import { readFileSync } from "node:fs";
import path from "node:path";
import { docsDir } from "../../../lib/docs-source.mjs";

export const GET: APIRoute = () =>
  new Response(readFileSync(path.join(docsDir(), "api/openapi.yaml"), "utf8"), { headers: { "Content-Type": "application/yaml; charset=utf-8" } });
