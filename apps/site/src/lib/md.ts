// The inline markdown subset used in src/data: **bold**, `code` and [text](url). Everything else is escaped.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function md(s: string): string {
  const code: string[] = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`);
  out = out
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
      const ext = /^https?:\/\//.test(href) && !href.startsWith("https://revenuedot.app");
      const h = href.startsWith("https://revenuedot.app/") ? href.slice("https://revenuedot.app".length) : href;
      return `<a href="${h}"${ext ? ' rel="noopener"' : ""}>${text}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[Number(i)]}</code>`);
}

/** Plain text for meta tags and JSON-LD: the subset with its marks removed. */
export const plain = (s: string) => s.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
