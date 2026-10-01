import { useEffect, useRef } from "react";
import type { FunnelTheme } from "@revenuedot/core/funnels";
import { ApiError } from "../../lib/api";
import { Icon } from "../../components/icons";
import "./web.css";

/** Pieces shared by the Web, Funnels, Web discounts and Domains pages. */

const THEME_KEYS: [keyof Omit<FunnelTheme, "corner_radius">, string][] = [["background", "Background"], ["text", "Text"], ["accent", "Accent"], ["button_text", "Button text"]];
const sameTheme = (a: FunnelTheme, b: FunnelTheme) => THEME_KEYS.every(([k]) => a[k].toLowerCase() === b[k].toLowerCase()) && a.corner_radius === b.corner_radius;

/** Colour presets as swatches, the four colours and the corner radius of hosted pages. */
export function ThemeEditor({ theme, presets, onChange, idBase }: { theme: FunnelTheme; presets: { name: string; theme: FunnelTheme }[]; onChange: (t: FunnelTheme) => void; idBase: string }) {
  return (
    <div className="wb-theme">
      <div className="wb-presets" role="group" aria-label="Colour presets">
        {presets.map((p) => (
          <button key={p.name} type="button" className="wb-preset" aria-pressed={sameTheme(p.theme, theme)} title={`${p.name} preset`} onClick={() => onChange({ ...p.theme })}>
            <span className="wb-sw" aria-hidden>{THEME_KEYS.map(([k]) => <i key={k} style={{ background: p.theme[k] }} />)}</span>
            <small>{p.name}</small>
          </button>
        ))}
      </div>
      <div className="wb-colors">
        {THEME_KEYS.map(([k, label]) => (
          <label key={k} className="wb-color" htmlFor={`${idBase}-${k}`}>
            <input id={`${idBase}-${k}`} type="color" value={theme[k].toLowerCase()} onChange={(e) => onChange({ ...theme, [k]: e.target.value.toUpperCase() })} />
            <span>{label}</span><code>{theme[k].toUpperCase()}</code>
          </label>
        ))}
      </div>
      <div className="wb-radius">
        <label htmlFor={`${idBase}-radius`}>Corner radius</label>
        <input id={`${idBase}-radius`} type="range" min={0} max={24} step={1} value={theme.corner_radius} onChange={(e) => onChange({ ...theme, corner_radius: Number(e.target.value) })} />
        <span className="mono">{theme.corner_radius}px</span>
      </div>
    </div>
  );
}

/**
 * The hosted page in a phone frame: the same HTML visitors get (renderFunnelPage in preview mode, which never calls the
 * network), in a sandboxed iframe. `step` switches the shown step without reloading the page.
 */
export function PagePreview({ html, step, title = "Funnel preview" }: { html: string; step?: string | null; title?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const post = () => { if (step) ref.current?.contentWindow?.postMessage({ rdStep: step }, "*"); };
  useEffect(post, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="wb-phone">
      <div className="wb-phone-screen"><iframe ref={ref} title={title} sandbox="allow-scripts" srcDoc={html} onLoad={post} /></div>
    </div>
  );
}

/** The API's message, and the parameter it names (for highlighting the field). */
export function apiError(e: unknown): { message: string; param: string | null } {
  if (e instanceof ApiError) {
    const b = e.body as { message?: string; param?: string } | null;
    return { message: b && typeof b === "object" && b.message ? b.message : e.message, param: b && typeof b === "object" && typeof b.param === "string" ? b.param : null };
  }
  if (e instanceof TypeError) return { message: "The request did not reach the server. Check your connection and try again.", param: null };
  return { message: e instanceof Error ? e.message : String(e), param: null };
}

/** A small empty-state picture: two phones joined by a line (funnels) or a page and a phone (links, discounts). */
export function Pictogram({ kind }: { kind: "funnel" | "link" | "discount" }) {
  return (
    <svg width="132" height="84" viewBox="0 0 132 84" aria-hidden className="wb-pict">
      <g fill="var(--panel)" stroke="var(--fg-3)" strokeWidth="1.25">
        {kind === "funnel" ? <>
          <rect x="22" y="8" width="34" height="68" /><rect x="76" y="8" width="34" height="68" />
          <path d="M28 22h22M28 32h22M28 42h22M82 22h22M82 30h14" fill="none" />
        </> : kind === "link" ? <>
          <rect x="14" y="20" width="66" height="50" /><path d="M14 30h66M22 42h30M22 50h20" fill="none" /><rect x="88" y="8" width="32" height="64" />
        </> : <>
          <rect x="30" y="14" width="72" height="56" /><path d="M40 28h32M40 38h52M40 48h24" fill="none" />
        </>}
      </g>
      {kind === "funnel" && <path d="M56 42h20" stroke="var(--fg-3)" strokeWidth="1.25" />}
      <rect x={kind === "funnel" ? 63 : kind === "link" ? 101 : 86} y={kind === "funnel" ? 39 : kind === "link" ? 54 : 54} width="6" height="6" fill="var(--accent)" />
    </svg>
  );
}

/** A labelled step marker for checklists: a check when done, the number otherwise. */
export function StepMark({ n, done }: { n: number; done: boolean }) {
  return <span className="n" aria-label={done ? `Step ${n}, done` : `Step ${n}`}>{done ? <Icon name="check" /> : n}</span>;
}
