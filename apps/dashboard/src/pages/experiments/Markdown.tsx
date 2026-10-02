import type { ReactNode } from "react";

/**
 * A small Markdown renderer for experiment notes: headings, paragraphs, bullet and numbered lists, **bold**, *italic*,
 * `code` and links (http, https and dashboard paths only). It builds React elements, never HTML, so notes cannot inject
 * markup. Anything else shows as text.
 */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\(([^)\s]+)\))/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k}>{m[3].slice(1, -1)}</em>);
    else if (m[4]) {
      const label = m[4].slice(1, m[4].indexOf("]("));
      const href = m[5]!;
      // http(s) links, or paths on this dashboard ("/projects/…"; never "//host" or "/\\host", which leave the site).
      out.push(/^(https?:\/\/|\/(?![\/\\]))/.test(href) ? <a key={k} href={href} target={href.startsWith("/") ? undefined : "_blank"} rel="noreferrer">{label}</a> : m[4]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length) { blocks.push(<p key={`p${blocks.length}`}>{inline(para.join(" "), `p${blocks.length}`)}</p>); para = []; }
    if (list) {
      const items = list.items.map((it, j) => <li key={j}>{inline(it, `l${blocks.length}-${j}`)}</li>);
      blocks.push(list.ordered ? <ol key={`l${blocks.length}`}>{items}</ol> : <ul key={`l${blocks.length}`}>{items}</ul>);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const b = /^\s*[-*]\s+(.*)$/.exec(line);
    const n = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) { flush(); continue; }
    if (h) { flush(); const Tag = (`h${h[1]!.length + 2}`) as "h3" | "h4" | "h5"; blocks.push(<Tag key={`h${blocks.length}`}>{inline(h[2]!, `h${blocks.length}`)}</Tag>); continue; }
    if (b || n) {
      if (para.length) flush();
      const ordered = !!n;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((b ?? n)![1]!);
      continue;
    }
    if (list) flush();
    para.push(line.trim());
  }
  flush();
  return <div className="rd-md xp-md">{blocks}</div>;
}
