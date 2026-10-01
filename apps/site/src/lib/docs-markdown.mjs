// Sätteri HTML-tree plugin for pages from the revenuedot/docs repo: rewrites relative links to site URLs, wraps
// tables for horizontal scroll, adds a copy button and language label to code blocks, and a # link to headings.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { satteriHeadingIdsPlugin } from "@astrojs/markdown-satteri";
import { docsDir, rewriteHref } from "./docs-source.mjs";

const LANGS = { bash: "Shell", sh: "Shell", shell: "Shell", zsh: "Shell", json: "JSON", jsonc: "JSON", ts: "TypeScript", typescript: "TypeScript", js: "JavaScript", javascript: "JavaScript", swift: "Swift", kotlin: "Kotlin", dart: "Dart", csharp: "C#", ruby: "Ruby", python: "Python", go: "Go", yaml: "YAML", diff: "Diff", http: "HTTP", csv: "CSV", cron: "Cron", text: "Text", plaintext: "Text" };

const el = (tagName, properties, children = []) => ({ type: "element", tagName, properties, children });
const text = (value) => ({ type: "text", value });

/** The docs-repo path of the file being rendered, or null when it is not a docs-repo file. */
function relOf(ctx) {
  if (!ctx.fileURL) return null;
  const rel = path.relative(docsDir(), fileURLToPath(ctx.fileURL));
  return rel.startsWith("..") ? null : rel;
}

const docsPlugin = {
  name: "revenuedot-docs",
  element: {
    filter: ["a", "table", "pre", "h2", "h3", "h4"],
    visit(node, ctx) {
      const rel = relOf(ctx);
      if (!rel) return;
      const tag = node.tagName;
      if (tag === "a") {
        const href = node.properties?.href;
        if (typeof href !== "string") return;
        // [![poster](x.webp)](x.mp4) stays a thumbnail link on GitHub and plays in place on the site.
        const img = node.children?.filter((c) => c.type === "element");
        if (/\.mp4$/.test(href) && img?.length === 1 && img[0].tagName === "img") {
          const { src, alt } = img[0].properties ?? {};
          return el("span", { className: ["shot", "doc-video"] }, [
            el("video", { controls: true, preload: "none", playsInline: true, poster: src, ariaLabel: alt, width: 1920, height: 1080 }, [
              el("source", { src: href, type: "video/mp4" }),
            ]),
          ]);
        }
        const next = rewriteHref(rel, href);
        if (next && next !== href) ctx.setProperty(node, "href", next);
        return;
      }
      if (tag === "table") return el("div", { className: ["table-wrap"], tabIndex: 0, role: "region", ariaLabel: "Table" }, [node]);
      if (tag === "pre") {
        const lang = String(node.properties?.dataLanguage ?? "text");
        const label = LANGS[lang] ?? lang.toUpperCase();
        return el("div", { className: ["codeblock"] }, [
          el("div", { className: ["code-head"], dataPagefindIgnore: "" }, [
            el("span", { className: ["label"] }, [text(label)]),
            el("button", { type: "button", className: ["copy"], ariaLabel: `Copy ${label} code` }, [text("Copy")]),
          ]),
          node,
        ]);
      }
      // Headings: ids were set by the heading-ids plugin that runs first (see hastPlugins below).
      const id = node.properties?.id;
      if (typeof id === "string" && id) {
        ctx.appendChild(node, el("a", { className: ["h-anchor"], href: `#${id}`, ariaLabel: `Link to this section`, dataPagefindIgnore: "" }, [text("#")]));
      }
    },
  },
};

/** hastPlugins for the Sätteri processor: heading ids first (so # links can use them), then the docs plugin. */
export const docsHastPlugins = [satteriHeadingIdsPlugin(), docsPlugin];
