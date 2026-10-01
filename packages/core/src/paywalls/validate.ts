/**
 * Validates paywall components JSON the way the RevenueCat SDKs decode it (purchases-ios `Sources/Paywalls/Components`,
 * decoded with `convertFromSnakeCase`). An error is something that makes the SDK fail to decode the paywall (it then
 * shows its fallback paywall) or renders it wrong (an empty text, a link that cannot open); a warning is something worth
 * fixing that the SDK tolerates. The table of required fields per component type is in prd/paywalls/PRD.md.
 */
import { type Json } from "./build.js";

export interface PaywallIssue { path: string; message: string; component_id?: string }
export interface PaywallValidation { valid: boolean; errors: PaywallIssue[]; warnings: PaywallIssue[] }
export interface ValidateOptions {
  /** Package identifiers of the paywall's offering; when given, packages that are not in it are warnings. */
  packages?: string[];
}

export const COMPONENT_TYPES = [
  "text", "image", "icon", "stack", "button", "package", "purchase_button", "sticky_footer", "timeline",
  "tabs", "tab_control", "tab_control_button", "tab_control_toggle", "carousel", "video", "countdown", "web_view",
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isInt = (x: unknown): x is number => Number.isInteger(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isBool = (x: unknown): x is boolean => typeof x === "boolean";
const isUrl = (x: unknown) => { if (!isStr(x) || !x.trim() || /\s/.test(x)) return false; try { return !!new URL(x).protocol; } catch { return false; } };

class Ctx {
  errors: PaywallIssue[] = [];
  warnings: PaywallIssue[] = [];
  ids = new Map<string, string>();
  texts = new Set<string>();
  urls = new Set<string>();
  packages: { id: string; selected: boolean; path: string; group: string }[] = [];
  purchaseButtons = 0;
  comp: string | undefined;
  depth = 0;
  constructor(readonly strings: Record<string, unknown> | null) {}
  err(path: string, message: string) { this.errors.push({ path, message, ...(this.comp ? { component_id: this.comp } : {}) }); }
  warn(path: string, message: string) { this.warnings.push({ path, message, ...(this.comp ? { component_id: this.comp } : {}) }); }
  /** A required key: present and not null (Swift `decode`, not `decodeIfPresent`). */
  req(o: Json, k: string, path: string): boolean {
    if (o[k] === undefined || o[k] === null) { this.err(`${path}.${k}`, `${k} is required.`); return false; }
    return true;
  }
}

function colorInfo(c: Ctx, v: unknown, path: string) {
  if (!isObj(v)) return c.err(path, "A colour is an object with type and value.");
  if (!["hex", "alias", "linear", "radial"].includes(v.type)) return c.err(`${path}.type`, `Colour type must be hex, alias, linear or radial, not ${JSON.stringify(v.type)}.`);
  if (v.type === "hex") {
    if (!isStr(v.value)) return c.err(`${path}.value`, "A hex colour needs a string value.");
    if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v.value)) c.warn(`${path}.value`, `${v.value} is not a #rrggbb or #rrggbbaa colour.`);
  } else if (v.type === "alias") {
    if (!isStr(v.value)) c.err(`${path}.value`, "An alias colour needs a string value.");
  } else {
    if (!Array.isArray(v.points)) return c.err(`${path}.points`, "A gradient needs points.");
    if (v.type === "linear" && !isInt(v.degrees)) c.err(`${path}.degrees`, "degrees must be a whole number.");
    v.points.forEach((p: unknown, i: number) => {
      if (!isObj(p) || !isStr(p.color)) c.err(`${path}.points[${i}].color`, "A gradient point needs a colour string.");
      else if (!isInt(p.percent)) c.err(`${path}.points[${i}].percent`, "percent must be a whole number.");
    });
  }
}
function scheme(c: Ctx, v: unknown, path: string) {
  if (!isObj(v)) return c.err(path, "A colour scheme is an object with light (and optionally dark).");
  if (!c.req(v, "light", path)) return;
  colorInfo(c, v.light, `${path}.light`);
  if (v.dark !== undefined && v.dark !== null) colorInfo(c, v.dark, `${path}.dark`);
}
function size(c: Ctx, v: unknown, path: string) {
  if (!isObj(v)) return c.err(path, "size is an object with width and height.");
  for (const k of ["width", "height"]) {
    if (!c.req(v, k, path)) continue;
    const s = v[k];
    if (!isObj(s) || !["fit", "fill", "fixed", "relative"].includes(s.type)) { c.warn(`${path}.${k}`, "Unknown size; the SDK uses fit."); continue; }
    if (s.type === "fixed" && !(isInt(s.value) && s.value >= 0)) c.warn(`${path}.${k}.value`, "A fixed size needs a whole, positive value; the SDK uses fit.");
    if (s.type === "relative" && !isNum(s.value)) c.warn(`${path}.${k}.value`, "A relative size needs a number; the SDK uses fit.");
  }
}
function padding(c: Ctx, v: unknown, path: string) {
  if (!isObj(v)) return c.err(path, "Padding and margin are objects with top, bottom, leading and trailing.");
  for (const k of ["top", "bottom", "leading", "trailing"]) if (v[k] !== undefined && v[k] !== null && !isNum(v[k])) c.err(`${path}.${k}`, `${k} must be a number.`);
}
function optPadding(c: Ctx, o: Json, k: string, path: string) { if (o[k] !== undefined && o[k] !== null) padding(c, o[k], `${path}.${k}`); }
function str(c: Ctx, o: Json, k: string, path: string, required = true) {
  if (o[k] === undefined || o[k] === null) { if (required) c.err(`${path}.${k}`, `${k} is required.`); return; }
  if (!isStr(o[k])) c.err(`${path}.${k}`, `${k} must be a string.`);
}
function num(c: Ctx, o: Json, k: string, path: string, required = true, int = false) {
  if (o[k] === undefined || o[k] === null) { if (required) c.err(`${path}.${k}`, `${k} is required.`); return; }
  if (int ? !isInt(o[k]) : !isNum(o[k])) c.err(`${path}.${k}`, `${k} must be a ${int ? "whole " : ""}number.`);
}
function bool(c: Ctx, o: Json, k: string, path: string, required = true) {
  if (o[k] === undefined || o[k] === null) { if (required) c.err(`${path}.${k}`, `${k} is required.`); return; }
  if (!isBool(o[k])) c.err(`${path}.${k}`, `${k} must be true or false.`);
}
function border(c: Ctx, v: unknown, path: string) {
  if (v === undefined || v === null) return;
  if (!isObj(v)) return c.err(path, "border is an object with color and width.");
  if (c.req(v, "color", path)) scheme(c, v.color, `${path}.color`);
  num(c, v, "width", path);
}
function shadow(c: Ctx, v: unknown, path: string) {
  if (v === undefined || v === null) return;
  if (!isObj(v)) return c.err(path, "shadow is an object with color, radius, x and y.");
  if (c.req(v, "color", path)) scheme(c, v.color, `${path}.color`);
  for (const k of ["radius", "x", "y"]) num(c, v, k, path);
}
function shape(c: Ctx, v: unknown, path: string, kinds = ["rectangle", "pill"]) {
  if (v === undefined || v === null) return;
  if (!isObj(v) || !kinds.includes(v.type)) c.warn(path, `Unknown shape; the SDK uses a plain rectangle. Use ${kinds.join(" or ")}.`);
}
/** Image and video masks: unlike other shapes, the SDK fails to decode one that is not an object. */
function maskShape(c: Ctx, v: unknown, path: string) {
  if (v !== undefined && v !== null && !isObj(v)) return c.err(path, "mask_shape is an object with a type (rectangle, circle, concave or convex).");
  shape(c, v, path, ["rectangle", "circle", "concave", "convex"]);
}
/** An optional list (decodeIfPresent of an array): anything but a list fails to decode. */
function optList(c: Ctx, o: Json, k: string, path: string) {
  if (o[k] !== undefined && o[k] !== null && !Array.isArray(o[k])) c.err(`${path}.${k}`, `${k} must be a list.`);
}
function transition(c: Ctx, v: unknown, path: string) {
  if (v === undefined || v === null) return;
  if (!isObj(v)) return c.err(path, "transition is an object with type and displacement_strategy.");
  c.req(v, "type", path);
  if (c.req(v, "displacement_strategy", path) && !["greedy", "lazy"].includes(v.displacement_strategy)) c.err(`${path}.displacement_strategy`, "displacement_strategy must be greedy or lazy.");
  if (v.animation !== undefined && v.animation !== null) {
    const a = v.animation, p = `${path}.animation`;
    if (!isObj(a)) c.err(p, "animation is an object with type, ms_delay and ms_duration.");
    else { c.req(a, "type", p); num(c, a, "ms_delay", p, true, true); num(c, a, "ms_duration", p, true, true); }
  }
}
function imageUrls(c: Ctx, v: unknown, path: string) {
  if (!isObj(v)) return c.err(path, "Image sources are an object with width, height, original, heic and heic_low_res.");
  num(c, v, "width", path, true, true); num(c, v, "height", path, true, true);
  for (const k of ["original", "heic", "heic_low_res"]) {
    if (!c.req(v, k, path)) continue;
    if (!isUrl(v[k])) c.err(`${path}.${k}`, `${k} must be a URL.`);
  }
}
function themeImage(c: Ctx, v: unknown, path: string) {
  if (!isObj(v)) return c.err(path, "An image source is an object with light (and optionally dark).");
  if (c.req(v, "light", path)) imageUrls(c, v.light, `${path}.light`);
  if (v.dark !== undefined && v.dark !== null) imageUrls(c, v.dark, `${path}.dark`);
}
function videoUrls(c: Ctx, v: unknown, path: string) {
  if (!isObj(v)) return c.err(path, "Video sources are an object with width, height and url.");
  num(c, v, "width", path, true, true); num(c, v, "height", path, true, true);
  if (c.req(v, "url", path) && !isUrl(v.url)) c.err(`${path}.url`, "url must be a URL.");
}
function themeVideo(c: Ctx, v: unknown, path: string) {
  if (!isObj(v)) return c.err(path, "A video source is an object with light (and optionally dark).");
  if (c.req(v, "light", path)) videoUrls(c, v.light, `${path}.light`);
  if (v.dark !== undefined && v.dark !== null) videoUrls(c, v.dark, `${path}.dark`);
}
function background(c: Ctx, v: unknown, path: string) {
  if (v === undefined || v === null) return;
  if (!isObj(v)) return c.err(path, "background is an object with a type.");
  if (v.type === "color") { if (c.req(v, "value", path)) scheme(c, v.value, `${path}.value`); }
  else if (v.type === "image") { if (c.req(v, "value", path)) themeImage(c, v.value, `${path}.value`); str(c, v, "fit_mode", path); }
  else if (v.type === "video") {
    if (c.req(v, "value", path)) themeVideo(c, v.value, `${path}.value`);
    if (c.req(v, "fallback_image", path)) themeImage(c, v.fallback_image, `${path}.fallback_image`);
    str(c, v, "fit_mode", path); bool(c, v, "loop", path); bool(c, v, "mute_audio", path);
  } else c.err(`${path}.type`, `Background type must be color, image or video, not ${JSON.stringify(v.type)}.`);
}
function dimension(c: Ctx, v: unknown, path: string) {
  if (!isObj(v)) return c.err(path, "dimension is an object with type, alignment and distribution.");
  if (!["vertical", "horizontal", "zlayer"].includes(v.type)) return c.err(`${path}.type`, "dimension.type must be vertical, horizontal or zlayer.");
  str(c, v, "alignment", path);
  if (v.type !== "zlayer") str(c, v, "distribution", path);
  const allowed = v.type === "vertical" ? ["leading", "center", "trailing"] : v.type === "horizontal" ? ["top", "center", "bottom"]
    : ["center", "leading", "trailing", "top", "bottom", "top_leading", "top_trailing", "bottom_leading", "bottom_trailing"];
  if (isStr(v.alignment) && !allowed.includes(v.alignment)) c.warn(`${path}.alignment`, `A ${v.type} stack aligns ${allowed.join(", ")}.`);
}
function textKey(c: Ctx, key: unknown, path: string) {
  if (!isStr(key)) return c.err(path, "A localization key must be a string.");
  c.texts.add(key);
  if (c.strings && !(key in c.strings)) c.err(path, `The default locale has no string "${key}"; the SDK would show an empty text.`);
}
function urlKey(c: Ctx, key: unknown, path: string) {
  if (!isStr(key)) return c.err(path, "url_lid must be a string.");
  c.urls.add(key);
  if (c.strings) {
    if (!(key in c.strings)) c.err(path, `The default locale has no URL "${key}".`);
    else if (!isUrl(c.strings[key])) c.err(path, `The string "${key}" must be a URL for this link to open.`);
  }
}

/** Overrides: an array of { conditions: [...], properties: {...} }; the partial properties are checked like the full ones. */
function overrides(c: Ctx, v: unknown, path: string, partial: (p: Json, path: string) => void) {
  if (v === undefined || v === null) return;
  if (!Array.isArray(v)) return c.err(path, "overrides must be a list.");
  v.forEach((o, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(o)) return c.err(p, "An override is an object with conditions and properties.");
    if (!Array.isArray(o.conditions)) c.err(`${p}.conditions`, "conditions must be a list.");
    else o.conditions.forEach((cond: unknown, j: number) => { if (!isObj(cond) || !isStr(cond.type)) c.warn(`${p}.conditions[${j}]`, "A condition needs a type; the SDK ignores this override."); });
    if (!isObj(o.properties)) return c.err(`${p}.properties`, "properties is required.");
    partial(o.properties, `${p}.properties`);
  });
}
const partialCommon = (c: Ctx, o: Json, path: string) => {
  if (o.visible !== undefined && o.visible !== null && !isBool(o.visible)) c.err(`${path}.visible`, "visible must be true or false.");
  if (o.size !== undefined && o.size !== null) size(c, o.size, `${path}.size`);
  optPadding(c, o, "padding", path); optPadding(c, o, "margin", path);
};
const partialText = (c: Ctx) => (o: Json, path: string) => {
  partialCommon(c, o, path);
  if (o.text_lid !== undefined && o.text_lid !== null) textKey(c, o.text_lid, `${path}.text_lid`);
  for (const k of ["color", "background_color"]) if (o[k] !== undefined && o[k] !== null) scheme(c, o[k], `${path}.${k}`);
  // A partial text decodes font_size as a plain number (no named sizes).
  if (o.font_size !== undefined && o.font_size !== null && !isNum(o.font_size)) c.err(`${path}.font_size`, "font_size in an override must be a number.");
  for (const k of ["font_weight", "horizontal_alignment", "font_name"]) str(c, o, k, path, false);
};
const partialStack = (c: Ctx) => (o: Json, path: string) => {
  partialCommon(c, o, path);
  if (o.dimension !== undefined && o.dimension !== null) dimension(c, o.dimension, `${path}.dimension`);
  if (o.spacing !== undefined && o.spacing !== null && !isNum(o.spacing)) c.err(`${path}.spacing`, "spacing must be a number.");
  if (o.background_color !== undefined && o.background_color !== null) scheme(c, o.background_color, `${path}.background_color`);
  background(c, o.background, `${path}.background`); border(c, o.border, `${path}.border`); shadow(c, o.shadow, `${path}.shadow`); shape(c, o.shape, `${path}.shape`);
  if (o.badge !== undefined && o.badge !== null) badge(c, o.badge, `${path}.badge`);
};
const partialImage = (c: Ctx) => (o: Json, path: string) => {
  partialCommon(c, o, path);
  if (o.source !== undefined && o.source !== null) themeImage(c, o.source, `${path}.source`);
  if (o.color_overlay !== undefined && o.color_overlay !== null) scheme(c, o.color_overlay, `${path}.color_overlay`);
  border(c, o.border, `${path}.border`); shadow(c, o.shadow, `${path}.shadow`);
};
const partialIcon = (c: Ctx) => (o: Json, path: string) => {
  partialCommon(c, o, path);
  if (o.color !== undefined && o.color !== null) scheme(c, o.color, `${path}.color`);
};
const partialVisible = (c: Ctx) => (o: Json, path: string) => partialCommon(c, o, path);

function badge(c: Ctx, v: unknown, path: string) {
  if (!isObj(v)) return c.err(path, "badge is an object with style, alignment and stack.");
  str(c, v, "style", path); str(c, v, "alignment", path);
  if (c.req(v, "stack", path)) stack(c, v.stack, `${path}.stack`);
}

function base(c: Ctx, o: Json, path: string, expected: string) {
  if (o.type !== expected) c.err(`${path}.type`, `type must be "${expected}".`);
  if (o.visible !== undefined && o.visible !== null && !isBool(o.visible)) c.err(`${path}.visible`, "visible must be true or false.");
  if (o.name !== undefined && o.name !== null && !isStr(o.name)) c.err(`${path}.name`, "name must be a string.");
  if (o.id !== undefined && o.id !== null) {
    if (!isStr(o.id)) c.err(`${path}.id`, "id must be a string.");
    else if (c.ids.has(o.id)) c.warn(`${path}.id`, `The id "${o.id}" is also used at ${c.ids.get(o.id)}.`);
    else c.ids.set(o.id, path);
  }
}

function text(c: Ctx, o: Json, path: string) {
  base(c, o, path, "text");
  if (c.req(o, "text_lid", path)) textKey(c, o.text_lid, `${path}.text_lid`);
  str(c, o, "font_weight", path);
  if (c.req(o, "color", path)) scheme(c, o.color, `${path}.color`);
  if (c.req(o, "font_size", path) && !isNum(o.font_size) && !isStr(o.font_size)) c.err(`${path}.font_size`, "font_size must be a number or a named size such as heading_l.");
  str(c, o, "horizontal_alignment", path);
  if (o.background_color !== undefined && o.background_color !== null) scheme(c, o.background_color, `${path}.background_color`);
  if (c.req(o, "size", path)) size(c, o.size, `${path}.size`);
  if (c.req(o, "padding", path)) padding(c, o.padding, `${path}.padding`);
  if (c.req(o, "margin", path)) padding(c, o.margin, `${path}.margin`);
  str(c, o, "font_name", path, false);
  num(c, o, "font_weight_int", path, false, true);
  overrides(c, o.overrides, `${path}.overrides`, partialText(c));
}
function image(c: Ctx, o: Json, path: string) {
  base(c, o, path, "image");
  if (c.req(o, "source", path)) themeImage(c, o.source, `${path}.source`);
  if (c.req(o, "size", path)) size(c, o.size, `${path}.size`);
  str(c, o, "fit_mode", path);
  str(c, o, "override_source_lid", path, false);
  maskShape(c, o.mask_shape, `${path}.mask_shape`);
  if (o.color_overlay !== undefined && o.color_overlay !== null) scheme(c, o.color_overlay, `${path}.color_overlay`);
  optPadding(c, o, "padding", path); optPadding(c, o, "margin", path);
  border(c, o.border, `${path}.border`); shadow(c, o.shadow, `${path}.shadow`);
  overrides(c, o.overrides, `${path}.overrides`, partialImage(c));
}
function icon(c: Ctx, o: Json, path: string) {
  base(c, o, path, "icon");
  if (c.req(o, "base_url", path) && !isUrl(o.base_url)) c.err(`${path}.base_url`, "base_url must be a URL.");
  str(c, o, "icon_name", path);
  if (c.req(o, "formats", path)) {
    if (!isObj(o.formats)) c.err(`${path}.formats`, "formats is an object with svg, png, heic and webp file names.");
    else for (const k of ["svg", "png", "heic", "webp"]) str(c, o.formats, k, `${path}.formats`);
  }
  if (c.req(o, "size", path)) size(c, o.size, `${path}.size`);
  if (c.req(o, "color", path)) scheme(c, o.color, `${path}.color`);
  optPadding(c, o, "padding", path); optPadding(c, o, "margin", path);
  if (o.icon_background !== undefined && o.icon_background !== null) {
    const b = o.icon_background, p = `${path}.icon_background`;
    if (!isObj(b)) c.err(p, "icon_background is an object with color and shape.");
    else { if (c.req(b, "color", p)) scheme(c, b.color, `${p}.color`); c.req(b, "shape", p); shape(c, b.shape, `${p}.shape`, ["rectangle", "circle"]); border(c, b.border, `${p}.border`); shadow(c, b.shadow, `${p}.shadow`); }
  }
  overrides(c, o.overrides, `${path}.overrides`, partialIcon(c));
}
/** Stacks nested deeper than this are refused: the SDKs decode and lay out recursively, and a deep tree exhausts the stack. */
export const MAX_STACK_DEPTH = 40;

function nested(c: Ctx, path: string, run: () => void) {
  if (c.depth >= MAX_STACK_DEPTH) return c.err(path, `Components are nested more than ${MAX_STACK_DEPTH} deep.`);
  c.depth++;
  try { run(); } finally { c.depth--; }
}
function stack(c: Ctx, o: unknown, path: string, group = path) {
  if (!isObj(o)) return c.err(path, "A stack is required here.");
  nested(c, path, () => stackBody(c, o, path, group));
}
function stackBody(c: Ctx, o: Json, path: string, group: string) {
  const prev = c.comp; c.comp = isStr(o.id) ? o.id : prev;
  base(c, o, path, "stack");
  if (!Array.isArray(o.components)) c.err(`${path}.components`, "components must be a list.");
  else o.components.forEach((x: unknown, i: number) => component(c, x, `${path}.components[${i}]`, group));
  if (c.req(o, "dimension", path)) dimension(c, o.dimension, `${path}.dimension`);
  if (c.req(o, "size", path)) size(c, o.size, `${path}.size`);
  if (o.spacing !== undefined && o.spacing !== null && !isNum(o.spacing)) c.err(`${path}.spacing`, "spacing must be a number.");
  if (o.background_color !== undefined && o.background_color !== null) scheme(c, o.background_color, `${path}.background_color`);
  background(c, o.background, `${path}.background`);
  if (c.req(o, "padding", path)) padding(c, o.padding, `${path}.padding`);
  if (c.req(o, "margin", path)) padding(c, o.margin, `${path}.margin`);
  shape(c, o.shape, `${path}.shape`); border(c, o.border, `${path}.border`); shadow(c, o.shadow, `${path}.shadow`);
  if (o.badge !== undefined && o.badge !== null) badge(c, o.badge, `${path}.badge`);
  overrides(c, o.overrides, `${path}.overrides`, partialStack(c));
  c.comp = prev;
}
function action(c: Ctx, a: unknown, path: string) {
  if (!isObj(a) || !isStr(a.type)) return c.err(path, "action is an object with a type (restore_purchases, navigate_back or navigate_to).");
  if (!["restore_purchases", "navigate_back", "navigate_to", "workflow", "close_workflow"].includes(a.type)) c.warn(`${path}.type`, `Unknown action ${a.type}; the button does nothing.`);
  if (a.type !== "navigate_to") return;
  if (!c.req(a, "destination", path)) return;
  if (!isStr(a.destination)) return c.err(`${path}.destination`, "destination must be a string.");
  if (["terms", "privacy_policy", "url", "web_paywall_link"].includes(a.destination)) {
    if (!c.req(a, "url", path)) return;
    if (!isObj(a.url)) return c.err(`${path}.url`, "url is an object with url_lid and method.");
    if (c.req(a.url, "url_lid", `${path}.url`)) urlKey(c, a.url.url_lid, `${path}.url.url_lid`);
    str(c, a.url, "method", `${path}.url`);
  } else if (a.destination === "sheet" && a.sheet !== undefined && a.sheet !== null) {
    const s = a.sheet;
    if (!isObj(s)) return c.err(`${path}.sheet`, "sheet is an object with id, stack and background_blur.");
    str(c, s, "id", `${path}.sheet`); bool(c, s, "background_blur", `${path}.sheet`);
    if (c.req(s, "stack", `${path}.sheet`)) stack(c, s.stack, `${path}.sheet.stack`);
  } else if (!["customer_center", "offer_code", "sheet"].includes(a.destination)) c.warn(`${path}.destination`, `Unknown destination ${a.destination}.`);
}

function component(c: Ctx, x: unknown, path: string, group: string) {
  if (!isObj(x)) return c.err(path, "A component must be an object.");
  const prev = c.comp; c.comp = isStr(x.id) ? x.id : prev;
  const t = x.type;
  switch (t) {
    case "text": text(c, x, path); break;
    case "image": image(c, x, path); break;
    case "icon": icon(c, x, path); break;
    case "stack": stack(c, x, path, group); break;
    case "button":
      base(c, x, path, "button");
      action(c, x.action, `${path}.action`);
      if (c.req(x, "stack", path)) stack(c, x.stack, `${path}.stack`, group);
      transition(c, x.transition, `${path}.transition`); optList(c, x, "state_updates", path);
      overrides(c, x.overrides, `${path}.overrides`, partialVisible(c));
      break;
    case "package":
      base(c, x, path, "package");
      if (c.req(x, "package_id", path)) {
        if (!isStr(x.package_id)) c.err(`${path}.package_id`, "package_id must be a string.");
        else c.packages.push({ id: x.package_id, selected: x.is_selected_by_default === true, path, group });
      }
      bool(c, x, "is_selected_by_default", path);
      str(c, x, "apple_promo_offer_product_code", path, false); bool(c, x, "haptic_feedback_enabled", path, false);
      if (c.req(x, "stack", path)) stack(c, x.stack, `${path}.stack`, group);
      overrides(c, x.overrides, `${path}.overrides`, partialVisible(c));
      break;
    case "purchase_button":
      base(c, x, path, "purchase_button");
      c.purchaseButtons += 1;
      if (c.req(x, "stack", path)) stack(c, x.stack, `${path}.stack`, group);
      if (x.method !== undefined && x.method !== null) {
        if (!isObj(x.method) || !isStr(x.method.type)) c.err(`${path}.method`, "method is an object with a type.");
        else if (["web_checkout", "web_product_selection", "custom_web_checkout"].includes(x.method.type)) {
          bool(c, x.method, "auto_dismiss", `${path}.method`, false); str(c, x.method, "open_method", `${path}.method`, false);
        }
        if (isObj(x.method) && x.method.type === "custom_web_checkout") {
          if (!isObj(x.method.custom_url)) c.err(`${path}.method.custom_url`, "custom_url is required for custom_web_checkout.");
          else if (c.req(x.method.custom_url, "url_lid", `${path}.method.custom_url`)) urlKey(c, x.method.custom_url.url_lid, `${path}.method.custom_url.url_lid`);
        }
      }
      if (x.action !== undefined && x.action !== null && !["in_app_checkout", "web_checkout", "web_product_selection"].includes(x.action)) c.err(`${path}.action`, "action must be in_app_checkout, web_checkout or web_product_selection.");
      break;
    case "sticky_footer":
      base(c, x, path, "sticky_footer");
      if (c.req(x, "stack", path)) stack(c, x.stack, `${path}.stack`, group);
      break;
    case "timeline":
      base(c, x, path, "timeline");
      for (const k of ["item_spacing", "text_spacing", "column_gutter"]) num(c, x, k, path, false);
      if (c.req(x, "size", path)) size(c, x.size, `${path}.size`);
      if (c.req(x, "padding", path)) padding(c, x.padding, `${path}.padding`);
      if (c.req(x, "margin", path)) padding(c, x.margin, `${path}.margin`);
      if (!Array.isArray(x.items)) c.err(`${path}.items`, "items must be a list.");
      else x.items.forEach((it: unknown, i: number) => {
        const p = `${path}.items[${i}]`;
        if (!isObj(it)) return c.err(p, "A timeline item is an object with title and icon.");
        if (c.req(it, "title", p)) { if (isObj(it.title)) text(c, it.title, `${p}.title`); else c.err(`${p}.title`, "title must be a text component."); }
        if (it.description !== undefined && it.description !== null) { if (isObj(it.description)) text(c, it.description, `${p}.description`); else c.err(`${p}.description`, "description must be a text component."); }
        if (c.req(it, "icon", p)) { if (isObj(it.icon)) icon(c, it.icon, `${p}.icon`); else c.err(`${p}.icon`, "icon must be an icon component."); }
        if (it.connector !== undefined && it.connector !== null) {
          const k = it.connector;
          if (!isObj(k)) c.err(`${p}.connector`, "connector is an object with width, color and margin.");
          else { num(c, k, "width", `${p}.connector`); if (c.req(k, "color", `${p}.connector`)) scheme(c, k.color, `${p}.connector.color`); if (c.req(k, "margin", `${p}.connector`)) padding(c, k.margin, `${p}.connector.margin`); }
        }
      });
      overrides(c, x.overrides, `${path}.overrides`, partialVisible(c));
      break;
    case "tabs": {
      base(c, x, path, "tabs");
      if (c.req(x, "size", path)) size(c, x.size, `${path}.size`);
      if (c.req(x, "padding", path)) padding(c, x.padding, `${path}.padding`);
      if (c.req(x, "margin", path)) padding(c, x.margin, `${path}.margin`);
      background(c, x.background, `${path}.background`); shape(c, x.shape, `${path}.shape`); border(c, x.border, `${path}.border`); shadow(c, x.shadow, `${path}.shadow`);
      if (c.req(x, "control", path)) {
        if (!isObj(x.control) || !["buttons", "toggle"].includes(x.control.type)) c.err(`${path}.control.type`, "control.type must be buttons or toggle.");
        if (isObj(x.control) && c.req(x.control, "stack", `${path}.control`)) stack(c, x.control.stack, `${path}.control.stack`);
      }
      const ids = new Set<string>();
      if (!Array.isArray(x.tabs) || !x.tabs.length) c.err(`${path}.tabs`, "tabs must be a list with at least one tab.");
      else x.tabs.forEach((tab: unknown, i: number) => {
        const p = `${path}.tabs[${i}]`;
        if (!isObj(tab)) return c.err(p, "A tab is an object with id and stack.");
        str(c, tab, "id", p); if (isStr(tab.id)) ids.add(tab.id);
        str(c, tab, "name", p, false);
        // Packages in different tabs are separate selections.
        if (c.req(tab, "stack", p)) stack(c, tab.stack, `${p}.stack`, `${p}`);
      });
      str(c, x, "default_tab_id", path, false); optList(c, x, "state_updates", path);
      if (isStr(x.default_tab_id) && !ids.has(x.default_tab_id)) c.warn(`${path}.default_tab_id`, `No tab has the id ${x.default_tab_id}.`);
      const walkButtons = (s: unknown) => {
        if (Array.isArray(s)) return s.forEach(walkButtons);
        if (!isObj(s)) return;
        if (s.type === "tab_control_button" && isStr(s.tab_id) && !ids.has(s.tab_id)) c.err(`${path}.control`, `A tab button points to the tab ${s.tab_id}, which does not exist.`);
        Object.values(s).forEach(walkButtons);
      };
      walkButtons(x.control);
      overrides(c, x.overrides, `${path}.overrides`, partialVisible(c));
      break;
    }
    case "tab_control": base(c, x, path, "tab_control"); break;
    case "tab_control_button":
      base(c, x, path, "tab_control_button");
      str(c, x, "tab_id", path); bool(c, x, "haptic_feedback_enabled", path, false);
      if (c.req(x, "stack", path)) stack(c, x.stack, `${path}.stack`, group);
      break;
    case "tab_control_toggle":
      base(c, x, path, "tab_control_toggle");
      for (const k of ["thumb_color_on", "thumb_color_off", "track_color_on", "track_color_off"]) if (c.req(x, k, path)) scheme(c, x[k], `${path}.${k}`);
      bool(c, x, "haptic_feedback_enabled", path, false);
      break;
    case "carousel":
      base(c, x, path, "carousel");
      if (x.size !== undefined && x.size !== null) size(c, x.size, `${path}.size`);
      optPadding(c, x, "padding", path); optPadding(c, x, "margin", path);
      background(c, x.background, `${path}.background`); shape(c, x.shape, `${path}.shape`); border(c, x.border, `${path}.border`); shadow(c, x.shadow, `${path}.shadow`);
      if (!Array.isArray(x.pages) || !x.pages.length) c.err(`${path}.pages`, "pages must be a list of stacks with at least one page.");
      else x.pages.forEach((p: unknown, i: number) => stack(c, p, `${path}.pages[${i}]`, group));
      str(c, x, "page_alignment", path);
      for (const k of ["page_spacing", "page_peek", "initial_page_index"]) num(c, x, k, path, true, true);
      bool(c, x, "loop", path); optList(c, x, "state_updates", path);
      if (x.auto_advance !== undefined && x.auto_advance !== null) {
        const a = x.auto_advance, p = `${path}.auto_advance`;
        if (!isObj(a)) c.err(p, "auto_advance is an object with ms_time_per_page and ms_transition_time.");
        else { num(c, a, "ms_time_per_page", p, true, true); num(c, a, "ms_transition_time", p, true, true); }
      }
      if (x.page_control !== undefined && x.page_control !== null) {
        const pc = x.page_control, p = `${path}.page_control`;
        if (!isObj(pc)) c.err(p, "page_control is an object.");
        else {
          str(c, pc, "position", p); num(c, pc, "spacing", p, true, true);
          for (const k of ["default", "active"]) {
            if (!c.req(pc, k, p)) continue;
            const d = pc[k];
            if (!isObj(d)) { c.err(`${p}.${k}`, "An indicator is an object with width, height and color."); continue; }
            num(c, d, "width", `${p}.${k}`, true, true); num(c, d, "height", `${p}.${k}`, true, true);
            if (c.req(d, "color", `${p}.${k}`)) scheme(c, d.color, `${p}.${k}.color`);
          }
          optPadding(c, pc, "padding", p); optPadding(c, pc, "margin", p);
          if (pc.background_color !== undefined && pc.background_color !== null) scheme(c, pc.background_color, `${p}.background_color`);
        }
      }
      overrides(c, x.overrides, `${path}.overrides`, partialVisible(c));
      break;
    case "video":
      base(c, x, path, "video");
      if (c.req(x, "source", path)) themeVideo(c, x.source, `${path}.source`);
      if (x.fallback_source !== undefined && x.fallback_source !== null) themeImage(c, x.fallback_source, `${path}.fallback_source`);
      for (const k of ["show_controls", "auto_play", "loop", "mute_audio"]) bool(c, x, k, path);
      if (c.req(x, "size", path)) size(c, x.size, `${path}.size`);
      str(c, x, "fit_mode", path);
      optPadding(c, x, "padding", path); optPadding(c, x, "margin", path);
      maskShape(c, x.mask_shape, `${path}.mask_shape`);
      if (x.color_overlay !== undefined && x.color_overlay !== null) scheme(c, x.color_overlay, `${path}.color_overlay`);
      border(c, x.border, `${path}.border`); shadow(c, x.shadow, `${path}.shadow`);
      overrides(c, x.overrides, `${path}.overrides`, partialVisible(c));
      break;
    case "countdown":
      base(c, x, path, "countdown");
      if (c.req(x, "style", path)) {
        if (!isObj(x.style) || x.style.type !== "date") c.err(`${path}.style`, 'style must be { "type": "date", "date": "<ISO 8601>" }.');
        else if (!isStr(x.style.date) || Number.isNaN(Date.parse(x.style.date))) c.err(`${path}.style.date`, "date must be an ISO 8601 date and time, such as 2026-12-31T23:59:59Z.");
      }
      if (c.req(x, "count_from", path) && !["days", "hours", "minutes"].includes(x.count_from)) c.err(`${path}.count_from`, "count_from must be days, hours or minutes.");
      if (c.req(x, "countdown_stack", path)) stack(c, x.countdown_stack, `${path}.countdown_stack`, group);
      if (x.end_stack !== undefined && x.end_stack !== null) stack(c, x.end_stack, `${path}.end_stack`, group);
      if (x.fallback !== undefined && x.fallback !== null) stack(c, x.fallback, `${path}.fallback`, group);
      overrides(c, x.overrides, `${path}.overrides`, partialVisible(c));
      break;
    case "web_view": {
      base(c, x, path, "web_view");
      if (!isStr(x.id) || !x.id.trim()) c.err(`${path}.id`, "A web view needs an id.");
      num(c, x, "protocol_version", path, true, true);
      // SDKs show `fallback` instead where they cannot run this web view: another protocol version, watchOS and tvOS.
      const hasFallback = isObj(x.fallback);
      if (isInt(x.protocol_version) && x.protocol_version !== 1 && !hasFallback) c.err(`${path}.protocol_version`, "The SDKs support web view protocol_version 1; another version needs a fallback component.");
      if (hasFallback) nested(c, `${path}.fallback`, () => component(c, x.fallback, `${path}.fallback`, group));
      else c.warn(`${path}.fallback`, "Without a fallback component, the paywall fails to load on watchOS, tvOS and SDKs without web views.");
      if (c.req(x, "url", path) && (!isStr(x.url) || !/^https:\/\/[^/\s{}]+/.test(x.url))) c.err(`${path}.url`, "A web view needs a resolved https URL.");
      if (c.req(x, "size", path)) size(c, x.size, `${path}.size`);
      overrides(c, x.overrides, `${path}.overrides`, partialVisible(c));
      break;
    }
    default:
      if (isObj(x.fallback)) {
        c.warn(`${path}.type`, `Unknown component type ${JSON.stringify(t)}; the SDK shows its fallback.`);
        nested(c, `${path}.fallback`, () => component(c, x.fallback, `${path}.fallback`, group));
      }
      else c.err(`${path}.type`, `Unknown component type ${JSON.stringify(t)}. Use one of: ${COMPONENT_TYPES.join(", ")}.`);
  }
  c.comp = prev;
}

/**
 * Validates `{ components_config, components_localizations, default_locale }`. Errors make the SDK fail or render a
 * broken paywall; publishing is refused while there are any.
 */
export function validatePaywall(doc: unknown, opts: ValidateOptions = {}): PaywallValidation {
  const d = isObj(doc) ? doc : {};
  const locs = isObj(d.components_localizations) ? d.components_localizations : null;
  const locale = isStr(d.default_locale) ? d.default_locale : "en_US";
  const strings = locs && isObj(locs[locale]) ? (locs[locale] as Record<string, unknown>) : null;
  const c = new Ctx(strings);
  if (d.default_locale !== undefined && !isStr(d.default_locale)) c.err("default_locale", "default_locale must be a locale id such as en_US.");
  if (!locs) c.err("components_localizations", "components_localizations is required: { \"en_US\": { \"key\": \"text\" } }.");
  else {
    if (!strings) c.err(`components_localizations.${locale}`, `The default locale ${locale} has no strings.`);
    // The SDK decodes every locale: one bad value anywhere fails the whole paywall.
    for (const [loc, table] of Object.entries(locs)) {
      if (!isObj(table)) { c.err(`components_localizations.${loc}`, "A locale's strings are an object of key to text."); continue; }
      for (const [k, v] of Object.entries(table)) {
        if (isStr(v)) continue;
        if (isObj(v)) themeImage(c, v, `components_localizations.${loc}.${k}`);
        else c.err(`components_localizations.${loc}.${k}`, "A localized value is a string or image sources.");
      }
    }
  }
  if (d.exit_offers !== undefined && d.exit_offers !== null) {
    const e = d.exit_offers;
    if (!isObj(e)) c.err("exit_offers", "exit_offers is an object with dismiss.");
    else if (e.dismiss !== undefined && e.dismiss !== null) {
      if (!isObj(e.dismiss)) c.err("exit_offers.dismiss", "exit_offers.dismiss is an object with offering_id.");
      else str(c, e.dismiss, "offering_id", "exit_offers.dismiss");
    }
  }
  const cfg = d.components_config;
  if (!isObj(cfg) || !isObj(cfg.base)) {
    c.err("components_config.base", "components_config.base is required.");
    return { valid: false, errors: c.errors, warnings: c.warnings };
  }
  const b = cfg.base;
  if (c.req(b, "stack", "components_config.base")) stack(c, b.stack, "components_config.base.stack");
  if (b.sticky_footer !== undefined && b.sticky_footer !== null) {
    const f = b.sticky_footer, p = "components_config.base.sticky_footer";
    if (!isObj(f)) c.err(p, "sticky_footer is an object with a stack.");
    else if (c.req(f, "stack", p)) stack(c, f.stack, `${p}.stack`);
  }
  if (b.header !== undefined && b.header !== null) {
    const h = b.header, p = "components_config.base.header";
    if (!isObj(h)) c.err(p, "header is an object with a stack.");
    else if (c.req(h, "stack", p)) stack(c, h.stack, `${p}.stack`);
  }
  if (c.req(b, "background", "components_config.base")) background(c, b.background, "components_config.base.background");

  // What renders wrong without failing to decode.
  if (c.purchaseButtons === 0) c.warnings.push({ path: "components_config.base", message: "There is no purchase button, so the paywall cannot sell anything." });
  if (!c.packages.length) c.warnings.push({ path: "components_config.base", message: "There are no packages; the purchase button buys nothing unless one is selected." });
  const groups = new Map<string, typeof c.packages>();
  for (const p of c.packages) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  for (const [, list] of groups) {
    const sel = list.filter((p) => p.selected);
    if (sel.length > 1) c.warnings.push({ path: sel[1]!.path, message: `More than one package is selected by default (${sel.map((p) => p.id).join(", ")}); the first one wins.` });
  }
  if (opts.packages) {
    for (const p of c.packages) if (!opts.packages.includes(p.id)) c.warnings.push({ path: `${p.path}.package_id`, message: `The offering has no package ${p.id}; the SDK hides this package.` });
  }
  // Other locales: a missing string falls back to the default locale when the server publishes (fillLocales).
  if (locs && strings) {
    for (const [loc, table] of Object.entries(locs)) {
      if (loc === locale || !isObj(table)) continue;
      const missing = [...c.texts].filter((k) => !(k in table) || (table[k] === "" && strings[k] !== ""));
      if (missing.length) c.warnings.push({ path: `components_localizations.${loc}`, message: `${missing.length} string${missing.length === 1 ? "" : "s"} not translated; the ${locale} text shows instead.` });
    }
  }
  return { valid: c.errors.length === 0, errors: c.errors, warnings: c.warnings };
}

/**
 * Copies the default locale's string into every other locale that lacks it, so the SDK never shows an empty text. An
 * empty translation counts as missing: the editor leaves "" behind when a translation is cleared.
 */
export function fillLocales(localizations: Record<string, Record<string, unknown>>, defaultLocale: string) {
  const base = localizations[defaultLocale] ?? {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [loc, table] of Object.entries(localizations)) {
    const own = isObj(table) ? Object.entries(table).filter(([k, v]) => v !== "" || !(k in base)) : [];
    out[loc] = loc === defaultLocale ? table : { ...base, ...Object.fromEntries(own) };
  }
  return out;
}
