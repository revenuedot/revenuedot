// Docs, API reference and blog posts come from the revenuedot/docs repo (see astro.config.mjs for where it lives).
// Entry ids are the repo paths without .md, for example "docs/getting-started/quickstart" or "api/rest-v1".
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { assertDocsDir, docsDir } from "./lib/docs-source.mjs";

const base = assertDocsDir(docsDir());
const generateId = ({ entry }: { entry: string }) => entry.replace(/\\/g, "/").replace(/\.md$/, "");

const docs = defineCollection({
  loader: glob({ base, pattern: ["docs/**/*.md", "api/*.md"], generateId }),
  schema: z.object({ title: z.string().min(1), description: z.string().min(1) }),
});

const blog = defineCollection({
  loader: glob({ base, pattern: ["blog/*.md"], generateId }),
  schema: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    date: z.coerce.date().optional(),
    author: z.string().optional(),
    draft: z.boolean().optional(),
    /** Cover image, a site path such as /blog/assets/<post>/cover.svg. */
    image: z.string().optional(),
  }),
});

export const collections = { docs, blog };
