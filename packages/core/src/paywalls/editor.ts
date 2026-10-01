/**
 * The visual editor's document operations, pure so they are unit-tested and shared by the dashboard: the component tree,
 * find by id, add, remove, duplicate, move (up, down, into the container above, out to the parent, to an index), and the
 * default component for each type. A document is `{ components_config, components_localizations, default_locale }`.
 */
import { FILL, FIT, PILL, ZERO, colorBg, fixed, imageUrls, pad, rounded, scheme, sz, type Json, type PaywallDoc } from "./build.js";

/** A list of children inside a component: the stack whose `components` hold them, and a label when it is not the only one. */
export interface ChildGroup { label: string | null; stack: Json; role: "content" | "tab" | "page" | "control" | "counting" | "ended" }

/** Containers and where their children live. Leaves return []. */
export function childGroups(c: Json): ChildGroup[] {
  switch (c?.type) {
    case "stack": return [{ label: null, stack: c, role: "content" }];
    case "button": case "package": case "purchase_button": case "sticky_footer": case "tab_control_button": case "footer":
      return c.stack ? [{ label: null, stack: c.stack, role: "content" }] : [];
    case "tabs": return [
      ...(Array.isArray(c.tabs) ? c.tabs.map((t: Json) => ({ label: `Tab · ${t.name ?? t.id}`, stack: t.stack, role: "tab" as const })) : []),
      ...(c.control?.stack ? [{ label: "Tab control", stack: c.control.stack, role: "control" as const }] : []),
    ];
    case "carousel": return Array.isArray(c.pages) ? c.pages.map((p: Json, i: number) => ({ label: `Page ${i + 1}`, stack: p, role: "page" as const })) : [];
    case "countdown": return [
      ...(c.countdown_stack ? [{ label: "While counting", stack: c.countdown_stack, role: "counting" as const }] : []),
      ...(c.end_stack ? [{ label: "After it ends", stack: c.end_stack, role: "ended" as const }] : []),
    ];
    default: return [];
  }
}

export interface Located { component: Json; list: Json[] | null; index: number; parent: Json | null; parentStack: Json | null }

/** The roots of the editor tree: the main stack and the sticky footer. */
export function roots(doc: PaywallDoc): Json[] {
  const b = doc.components_config.base;
  return [b.stack, ...(b.sticky_footer ? [b.sticky_footer] : [])];
}

/** Finds a component by id anywhere in the paywall, with the list it sits in. */
export function locate(doc: PaywallDoc, id: string): Located | null {
  const visit = (c: Json, list: Json[] | null, index: number, parent: Json | null, parentStack: Json | null): Located | null => {
    if (c?.id === id) return { component: c, list, index, parent, parentStack };
    for (const g of childGroups(c)) {
      if (g.stack !== c && g.stack?.id === id) return { component: g.stack, list: null, index: -1, parent: c, parentStack: null };
      const kids: Json[] = g.stack?.components ?? [];
      for (let i = 0; i < kids.length; i++) { const r = visit(kids[i]!, kids, i, c, g.stack); if (r) return r; }
    }
    return null;
  };
  for (const r of roots(doc)) { const f = visit(r, null, -1, null, null); if (f) return f; }
  return null;
}

/** A fresh random id (10 characters) that is not used in the paywall. */
export function freshId(doc: PaywallDoc | null, prefix = "c") {
  for (;;) {
    const id = `${prefix[0]}${Math.random().toString(36).slice(2, 11).padEnd(9, "0")}`;
    if (!doc || !locate(doc, id)) return id;
  }
}

/** Gives every component in `c` (and its overrides' text keys) new ids and new string keys, copying the strings in every locale. */
function reId(doc: PaywallDoc, c: Json): Json {
  const copy = JSON.parse(JSON.stringify(c)) as Json;
  const keyMap = new Map<string, string>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== "object") return;
    const o = x as Json;
    if (typeof o.type === "string" && typeof o.id === "string") o.id = freshId(doc, o.id);
    for (const [k, v] of Object.entries(o)) {
      if ((k === "text_lid" || k === "url_lid") && typeof v === "string") {
        if (!keyMap.has(v)) keyMap.set(v, freshId(null, "l"));
        o[k] = keyMap.get(v);
      } else walk(v);
    }
  };
  walk(copy);
  for (const table of Object.values(doc.components_localizations)) for (const [from, to] of keyMap) if (from in table) table[to] = table[from]!;
  return copy;
}

export type Op =
  | { kind: "remove"; id: string }
  | { kind: "duplicate"; id: string }
  | { kind: "move"; id: string; delta: number }
  | { kind: "moveTo"; id: string; targetId: string; position: "before" | "after" | "inside" }
  | { kind: "into"; id: string }
  | { kind: "out"; id: string }
  | { kind: "insert"; component: Json; targetId: string | null; position: "after" | "inside" };

/**
 * Applies one tree operation to a copy of the document. Returns the new document and the id to select, or null when
 * the operation does not apply (the root cannot move, a leaf cannot take children).
 */
export function applyOp(src: PaywallDoc, op: Op): { doc: PaywallDoc; select: string | null } | null {
  const doc = JSON.parse(JSON.stringify(src)) as PaywallDoc;
  const root = doc.components_config.base.stack;
  if (op.kind === "insert") {
    const target = op.targetId ? locate(doc, op.targetId) : null;
    if (op.component.type === "sticky_footer") {
      if (doc.components_config.base.sticky_footer) return null;
      doc.components_config.base.sticky_footer = op.component;
      return { doc, select: op.component.id };
    }
    if (!target) { root.components.push(op.component); return { doc, select: op.component.id }; }
    const groups = childGroups(target.component);
    if (op.position === "inside" && groups.length) { groups[0]!.stack.components.push(op.component); return { doc, select: op.component.id }; }
    if (target.list) { target.list.splice(target.index + 1, 0, op.component); return { doc, select: op.component.id }; }
    // The target is a root or a group stack: add inside it.
    const g = childGroups(target.component)[0];
    if (!g) return null;
    g.stack.components.push(op.component);
    return { doc, select: op.component.id };
  }
  const at = locate(doc, op.id);
  if (!at || !at.list) return null;
  const { list, index, component } = at;
  switch (op.kind) {
    case "remove": list.splice(index, 1); return { doc, select: list[Math.min(index, list.length - 1)]?.id ?? at.parentStack?.id ?? at.parent?.id ?? null };
    case "duplicate": { const copy = reId(doc, component); list.splice(index + 1, 0, copy); return { doc, select: copy.id }; }
    case "move": {
      const to = index + op.delta;
      if (to < 0 || to >= list.length) return null;
      list.splice(index, 1); list.splice(to, 0, component);
      return { doc, select: component.id };
    }
    case "into": {
      const prev = list[index - 1];
      const g = prev ? childGroups(prev)[0] : undefined;
      if (!g) return null;
      list.splice(index, 1); g.stack.components.push(component);
      return { doc, select: component.id };
    }
    case "out": {
      if (!at.parent) return null;
      const up = locate(doc, at.parent.id);
      if (!up?.list) return null;
      list.splice(index, 1); up.list.splice(up.index + 1, 0, component);
      return { doc, select: component.id };
    }
    case "moveTo": {
      if (op.targetId === op.id) return null;
      // Never into itself or its own children.
      const inside = (c: Json): boolean => c.id === op.targetId || childGroups(c).some((g) => g.stack.id === op.targetId || g.stack.components.some(inside));
      if (inside(component)) return null;
      list.splice(index, 1);
      const t = locate(doc, op.targetId);
      if (!t) return null;
      if (op.position === "inside") { const g = childGroups(t.component)[0]; if (!g) return null; g.stack.components.push(component); }
      else if (t.list) t.list.splice(t.index + (op.position === "after" ? 1 : 0), 0, component);
      else return null;
      return { doc, select: component.id };
    }
  }
  return null;
}

/** Sets a string in one locale (adds the key when the text has none yet). */
export function setString(doc: PaywallDoc, locale: string, key: string, value: string): PaywallDoc {
  const next = JSON.parse(JSON.stringify(doc)) as PaywallDoc;
  next.components_localizations[locale] = { ...(next.components_localizations[locale] ?? {}), [key]: value };
  return next;
}

export interface NewComponentContext {
  doc: PaywallDoc;
  iconBaseUrl: string;
  /** The offering's package identifiers; a new package takes the first one not on the paywall yet. */
  packages: string[];
  colors?: { text?: string; accent?: string; background?: string; muted?: string };
}

/** Component types the editor's Add menu offers (tab buttons, toggles and the control placeholder come with Tabs). */
export const ADDABLE_TYPES = ["text", "image", "icon", "stack", "button", "package", "purchase_button", "sticky_footer", "timeline", "tabs", "carousel", "video", "countdown", "web_view"] as const;
export type AddableType = (typeof ADDABLE_TYPES)[number];

/**
 * A new component of `type` with sensible defaults; its strings are written into the default locale of `ctx.doc`
 * (mutated). Video and web view start without a URL and show as problems until one is set.
 */
export function newComponent(type: AddableType, ctx: NewComponentContext): Json {
  const doc = ctx.doc;
  const loc = (doc.components_localizations[doc.default_locale] ??= {});
  const fg = ctx.colors?.text ?? "#111111", accent = ctx.colors?.accent ?? "#111111", bg = ctx.colors?.background ?? "#ffffff", muted = ctx.colors?.muted ?? "#737373";
  const id = (p: string) => freshId(doc, p);
  const str = (v: string) => { const k = freshId(null, "l"); loc[k] = v; return k; };
  const text = (v: string, o: { size?: number; weight?: string; color?: string; align?: string; width?: Json } = {}): Json => ({
    id: id("t"), type: "text", text_lid: str(v), color: scheme(o.color ?? fg), font_size: o.size ?? 16, font_weight: o.weight ?? "regular",
    horizontal_alignment: o.align ?? "center", size: sz(o.width ?? FILL, FIT), padding: ZERO, margin: ZERO,
  });
  const stack = (components: Json[], o: Json = {}): Json => ({
    id: id("s"), type: "stack", components, dimension: o.dimension ?? { type: "vertical", alignment: "center", distribution: "start" }, size: o.size ?? sz(FILL, FIT),
    spacing: o.spacing ?? 0, padding: o.padding ?? ZERO, margin: ZERO, background: o.background ?? null, ...(o.shape ? { shape: o.shape } : {}), ...(o.border ? { border: o.border } : {}), ...(o.overrides ? { overrides: o.overrides } : {}),
  });
  const icon = (name: string, size = 20, color = fg): Json => ({
    id: id("n"), type: "icon", base_url: ctx.iconBaseUrl, icon_name: name, formats: { svg: `${name}.svg`, png: `${name}.png`, heic: `${name}.png`, webp: `${name}.png` },
    size: sz(fixed(size), fixed(size)), padding: ZERO, margin: ZERO, color: scheme(color), icon_background: null,
  });
  const used = new Set<string>();
  for (const r of roots(doc)) JSON.stringify(r, (k, v) => { if (k === "package_id") used.add(v); return v; });
  const nextPackage = () => ctx.packages.find((p) => !used.has(p)) ?? ctx.packages[0] ?? "$rc_monthly";
  const packageCard = (pid: string): Json => ({
    id: id("p"), type: "package", package_id: pid, is_selected_by_default: false,
    stack: stack([text(pid.replace(/^\$rc_/, "").replace(/^./, (c) => c.toUpperCase()), { weight: "semibold", align: "leading" }), text("{{ product.price_per_period_abbreviated }}", { align: "trailing", width: FIT })], {
      dimension: { type: "horizontal", alignment: "center", distribution: "space_between" }, padding: pad(14, 16), spacing: 12, shape: rounded(12), border: { color: scheme("#d4d4d4"), width: 1 },
      overrides: [{ conditions: [{ type: "selected" }], properties: { border: { color: scheme(accent), width: 2 } } }],
    }),
  });
  switch (type) {
    case "text": return text("New text");
    case "image": return { id: id("i"), type: "image", source: { light: imageUrls(`${ctx.iconBaseUrl}/image.png`, 96, 96) }, size: sz(FILL, fixed(180)), fit_mode: "fit", padding: ZERO, margin: ZERO };
    case "icon": return icon("star", 24, accent);
    case "stack": return stack([text("Stack")], { padding: pad(12), spacing: 8 });
    case "button": return { id: id("b"), type: "button", action: { type: "restore_purchases" }, stack: stack([text("Restore purchases", { size: 13, color: muted, width: FIT })], { size: sz(FIT, FIT) }) };
    case "package": return packageCard(nextPackage());
    case "purchase_button": return {
      id: id("u"), type: "purchase_button", action: "in_app_checkout", method: { type: "in_app_checkout" },
      stack: stack([text("Continue", { size: 17, weight: "semibold", color: "#ffffff" })], { padding: pad(15, 16), background: colorBg(accent), shape: PILL }),
    };
    case "sticky_footer": return { id: id("f"), type: "sticky_footer", stack: stack([], { padding: pad(16, 20), spacing: 12, background: colorBg(bg) }) };
    case "timeline": return {
      id: id("l"), type: "timeline", icon_alignment: "title", item_spacing: 18, text_spacing: 4, column_gutter: 14, size: sz(FILL, FIT), padding: ZERO, margin: ZERO,
      items: [["unlock", "Today", "Full access starts now"], ["bell", "Before it ends", "We send you a reminder"], ["star", "Trial ends", "Your plan starts"]].map(([n, t, d]) => ({
        title: text(t!, { weight: "semibold", align: "leading" }), description: text(d!, { size: 14, color: muted, align: "leading" }),
        // The icon's size includes its padding (RevenueCatUI pads inside the frame): a 16pt glyph in a 28pt circle.
        icon: { ...icon(n!, 28, "#ffffff"), padding: pad(6), icon_background: { color: scheme(accent), shape: { type: "circle" } } }, connector: { width: 2, color: scheme("#e5e5e5"), margin: pad(4, 0) },
      })),
    };
    case "tabs": {
      const a = id("x"), b = id("x");
      const btn = (tab: string, label: string): Json => ({
        id: id("k"), type: "tab_control_button", tab_id: tab,
        stack: stack([text(label, { size: 14, weight: "semibold", width: FIT })], { padding: pad(8), shape: rounded(8), overrides: [{ conditions: [{ type: "selected" }], properties: { background: colorBg(bg) } }] }),
      });
      return {
        id: id("a"), type: "tabs", size: sz(FILL, FIT), padding: ZERO, margin: ZERO,
        control: { type: "buttons", stack: stack([btn(a, "Plus"), btn(b, "Pro")], { dimension: { type: "horizontal", alignment: "center", distribution: "start" }, spacing: 4, padding: pad(4), background: colorBg("#f0f0f0"), shape: rounded(10) }) },
        tabs: [{ id: a, name: "Plus", stack: stack([{ id: id("c"), type: "tab_control" }, text("Plus benefits")], { spacing: 12 }) }, { id: b, name: "Pro", stack: stack([{ id: id("c"), type: "tab_control" }, text("Pro benefits")], { spacing: 12 }) }],
        default_tab_id: a,
      };
    }
    case "carousel": return {
      id: id("r"), type: "carousel", size: sz(FILL, FIT), padding: ZERO, margin: ZERO, background: null,
      pages: [1, 2].map((n) => stack([text(`Page ${n}`, { size: 20, weight: "bold" })], { padding: pad(24), background: colorBg("#f5f5f5"), shape: rounded(16), size: sz(FILL, fixed(200)) })),
      page_alignment: "center", page_spacing: 12, page_peek: 0, initial_page_index: 0, loop: false,
      page_control: { position: "bottom", spacing: 6, padding: pad(10, 0), margin: ZERO, default: { width: 6, height: 6, color: scheme("#d4d4d4") }, active: { width: 18, height: 6, color: scheme(fg) } },
    };
    case "video": return { id: id("v"), type: "video", source: { light: { width: 1080, height: 1920, url: "" } }, show_controls: false, auto_play: true, loop: true, mute_audio: true, size: sz(FILL, fixed(220)), fit_mode: "fill", padding: ZERO, margin: ZERO };
    case "countdown": return {
      id: id("d"), type: "countdown", style: { type: "date", date: new Date(Date.now() + 3 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z") }, count_from: "days",
      countdown_stack: stack([text("Ends in {{ count_days_without_zero }}d {{ count_hours_with_zero }}:{{ count_minutes_with_zero }}:{{ count_seconds_with_zero }}", { weight: "semibold" })]),
      end_stack: stack([text("This offer has ended", { color: muted })]),
    };
    case "web_view": return { id: id("w"), type: "web_view", protocol_version: 1, url: "", size: sz(FILL, fixed(240)) };
  }
}

/** A short label for a component in the tree: its text, package, icon or name. */
export function componentLabel(c: Json, strings: Record<string, unknown>): string {
  if (typeof c.name === "string" && c.name) return c.name;
  const firstText = (x: Json): string | null => {
    if (x?.type === "text" && typeof strings[x.text_lid] === "string") return strings[x.text_lid] as string;
    for (const g of childGroups(x)) for (const k of g.stack.components ?? []) { const t = firstText(k); if (t) return t; }
    return null;
  };
  switch (c.type) {
    case "text": return (strings[c.text_lid] as string | undefined) ?? "Text";
    case "package": return c.package_id;
    case "icon": return c.icon_name;
    case "image": return "Image";
    case "timeline": return `${c.items?.length ?? 0} steps`;
    case "tabs": return (c.tabs ?? []).map((t: Json) => t.name ?? t.id).join(" · ");
    case "carousel": return `${c.pages?.length ?? 0} pages`;
    case "countdown": return `until ${String(c.style?.date ?? "").slice(0, 10)}`;
    case "video": case "web_view": return c.url || c.source?.light?.url || "no URL";
    case "button": return firstText(c) ?? (c.action?.type === "restore_purchases" ? "Restore" : "Button");
    case "purchase_button": return firstText(c) ?? "Purchase";
    default: return firstText(c) ?? "";
  }
}

export const TYPE_LABEL: Record<string, string> = {
  text: "Text", image: "Image", icon: "Icon", stack: "Stack", button: "Button", package: "Package", purchase_button: "Purchase button", sticky_footer: "Sticky footer",
  timeline: "Timeline", tabs: "Tabs", tab_control: "Tab control", tab_control_button: "Tab button", tab_control_toggle: "Tab toggle", carousel: "Carousel", video: "Video",
  countdown: "Countdown", web_view: "Web view", footer: "Sticky footer",
};
