import type { FunnelDoc, FunnelStep, FunnelTheme } from "./types.js";

/**
 * The one renderer for hosted web pages (prd/web-billing/PRD.md §2–§5): funnels, purchase links and the success page.
 * A pure function from the funnel, the checkout look, the packages and the URLs to a complete HTML document with a small
 * inline script. The server serves it to visitors; the dashboard renders it into the builder's preview (mode "preview",
 * which never calls the network). Every text is escaped; colours are validated hex; images must be https.
 */

export interface PageLook {
  app_name: string;
  logo_url?: string | null;
  terms_url?: string | null;
  privacy_url?: string | null;
  support_email?: string | null;
}

export interface PagePackage {
  /** Package lookup key ($rc_monthly). */
  id: string;
  name: string;
  /** "$9.99" */
  price: string;
  /** "per month", "once" */
  period: string;
  /** "7-day free trial, then $9.99 per month" */
  detail: string;
  /** A badge such as "Save 33%" (the builder may set none). */
  badge?: string | null;
}

export interface PageSuccess {
  /** paid: show the redemption link; identified: the purchase is on the app user id already; processing: Stripe has not confirmed yet. */
  status: "paid" | "identified" | "processing";
  /** https page that opens the app with the redemption deep link. */
  redeem_url?: string | null;
  deep_link?: string | null;
  app_store_url?: string | null;
  play_store_url?: string | null;
}

export interface RenderInput {
  funnel: FunnelDoc;
  look: PageLook;
  /** Packages of each offering the paywall steps use, by offering lookup key ("" for the current offering). */
  packages: Record<string, PagePackage[]>;
  mode: "live" | "preview";
  /** Show this step first (the builder's selected step; the success page). */
  startStepId?: string | null;
  urls?: { checkout?: string; events?: string; discount?: string };
  context?: {
    project?: string; slug?: string; funnel_id?: string | null; link_id?: string | null; session_id?: string;
    app_user_id?: string | null; email?: string | null; code?: string | null; canceled?: boolean; query?: Record<string, string>;
  };
  success?: PageSuccess | null;
  /** A note shown above the page (an expired link). */
  notice?: string | null;
  /** CSP nonce for the inline script and style. */
  nonce?: string;
  title?: string;
}

export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const HEX = /^#[0-9a-fA-F]{6}$/;
const color = (v: string, fallback: string) => (HEX.test(v) ? v : fallback);
const httpsOrNull = (v: unknown) => (typeof v === "string" && /^https:\/\/[^\s"'<>]+$/.test(v) ? v : null);
/** JSON inside <script>: `<` and line separators escaped, so no text can close the tag. */
const scriptJson = (o: unknown) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** Mixes a colour with the background (for hairlines and quiet fills). */
function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v * (1 - t) + y[i]! * t).toString(16).padStart(2, "0")).join("")}`;
}

/* ---------- price labels ---------- */

const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
export const minorToMajor = (minor: number, currency: string) => (ZERO_DECIMAL.has(currency.toLowerCase()) ? minor : minor / 100);
export const majorToMinor = (major: number, currency: string) => (ZERO_DECIMAL.has(currency.toLowerCase()) ? Math.round(major) : Math.round(major * 100));

export function formatMoney(minor: number, currency: string, locale = "en-US"): string {
  try { return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(minorToMajor(minor, currency)); }
  catch { return `${minorToMajor(minor, currency)} ${currency.toUpperCase()}`; }
}

export function periodLabel(interval: string | null | undefined, count: number | null | undefined): string {
  if (!interval) return "once";
  const n = count ?? 1;
  if (interval === "month" && n === 3) return "every 3 months";
  if (interval === "month" && n === 6) return "every 6 months";
  if (n === 1) return `per ${interval}`;
  return `every ${n} ${interval}s`;
}

/** The labels of one web price, e.g. { price: "$9.99", period: "per month", detail: "7-day free trial, then $9.99 per month" }. */
export function priceLabels(p: { amount_minor: number; currency: string; interval?: string | null; interval_count?: number | null; trial_days?: number | null }, locale = "en-US") {
  const price = formatMoney(p.amount_minor, p.currency, locale);
  const period = periodLabel(p.interval, p.interval_count);
  const detail = p.trial_days && p.interval ? `${p.trial_days}-day free trial, then ${price} ${period}` : p.interval ? `${price} ${period}, cancel anytime` : `${price} one-time payment`;
  return { price, period, detail };
}

/* ---------- page ---------- */

function css(t: FunnelTheme): string {
  const bg = color(t.background, "#FFFFFF"), fg = color(t.text, "#0A0A0A"), ac = color(t.accent, "#0A0A0A"), bt = color(t.button_text, "#FFFFFF");
  const r = Math.max(0, Math.min(24, Number(t.corner_radius) || 0));
  return `:root{--bg:${bg};--fg:${fg};--fg2:${mix(fg, bg, 0.35)};--fg3:${mix(fg, bg, 0.5)};--line:${mix(fg, bg, 0.85)};--soft:${mix(ac, bg, 0.92)};--ac:${ac};--bt:${bt};--r:${r}px}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:500 16px/1.5 Manrope,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;flex-direction:column}
.wrap{width:100%;max-width:480px;margin:0 auto;padding:16px 20px 32px;flex:1;display:flex;flex-direction:column}
.top{display:flex;align-items:center;gap:12px;min-height:40px}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;letter-spacing:-.01em}.brand img{height:28px;width:auto;display:block}
.back{border:0;background:none;color:var(--fg2);font:inherit;font-size:14px;cursor:pointer;padding:8px 0;margin-left:auto}
.bar{height:3px;background:var(--line);margin:12px 0 28px}.bar i{display:block;height:100%;background:var(--ac);transition:width .25s}
section{display:none;flex-direction:column;flex:1}section.on{display:flex}
h1{font-size:28px;line-height:1.18;letter-spacing:-.03em;margin:0 0 10px;font-weight:700}
.sub{color:var(--fg2);margin:0 0 24px;font-size:16px}
.opts{display:flex;flex-direction:column;gap:10px;margin-bottom:24px}
.opt{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:16px;border:1px solid var(--line);border-radius:var(--r);background:var(--bg);color:var(--fg);font:inherit;font-weight:600;cursor:pointer}
.opt:hover{border-color:var(--fg3)}.opt[aria-pressed=true],.opt[aria-checked=true]{border-color:var(--ac);background:var(--soft);box-shadow:inset 0 0 0 1px var(--ac)}
.cta{margin-top:auto;display:block;width:100%;padding:16px;border:0;border-radius:var(--r);background:var(--ac);color:var(--bt);font:inherit;font-weight:700;font-size:15px;letter-spacing:.02em;cursor:pointer;text-align:center;text-decoration:none}
.cta[disabled]{opacity:.45;cursor:default}.cta.ghost{background:none;color:var(--fg);border:1px solid var(--line);margin-top:10px}
input.in{width:100%;padding:15px 14px;border:1px solid var(--line);border-radius:var(--r);background:var(--bg);color:var(--fg);font:inherit;margin-bottom:8px}
input.in:focus,.opt:focus-visible,.cta:focus-visible,.pkg:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
.err{color:#C2410C;font-size:14px;min-height:20px;margin:0 0 12px}.ok{color:#5F822B;font-size:14px;min-height:20px;margin:0 0 12px}
.img{width:100%;border-radius:var(--r);margin-bottom:20px;display:block}
.body{color:var(--fg2);margin:0 0 24px;white-space:pre-line}
ul.feat{list-style:none;padding:0;margin:0 0 20px}ul.feat li{padding:6px 0 6px 28px;position:relative}ul.feat li:before{content:"";position:absolute;left:2px;top:11px;width:12px;height:7px;border-left:2px solid var(--ac);border-bottom:2px solid var(--ac);transform:rotate(-45deg)}
.pkgs{display:flex;flex-direction:column;gap:10px;margin-bottom:16px}
.pkg{display:grid;grid-template-columns:20px 1fr auto;gap:12px;align-items:center;padding:16px;border:1px solid var(--line);border-radius:var(--r);cursor:pointer;background:var(--bg);color:var(--fg);font:inherit;text-align:left;width:100%}
.pkg .dot{width:18px;height:18px;border:1.5px solid var(--fg3);border-radius:50%}.pkg[aria-checked=true] .dot{border:5px solid var(--ac)}
.pkg b{display:block;font-size:16px}.pkg small{display:block;color:var(--fg2);font-size:13px;line-height:1.4}.pkg .amt{font-weight:700;text-align:right}.pkg .amt small{font-weight:500}
.badge{display:inline-block;margin-left:6px;padding:1px 6px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:var(--ac);color:var(--bt);border-radius:calc(var(--r)/2)}
.code{display:flex;gap:8px;margin-bottom:4px}.code input{margin:0}.code button{flex:none;padding:0 16px;border:1px solid var(--line);border-radius:var(--r);background:var(--bg);color:var(--fg);font:inherit;font-weight:600;cursor:pointer}
details{margin-bottom:12px}summary{cursor:pointer;color:var(--fg2);font-size:14px;padding:4px 0 10px}
.fine{color:var(--fg3);font-size:12px;line-height:1.5;text-align:center;margin:12px 0 0}
.note{border:1px solid var(--line);border-radius:var(--r);padding:12px 14px;font-size:14px;color:var(--fg2);margin-bottom:20px}
.stores{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}.stores .cta{margin:0;font-size:14px;padding:13px}
.link{word-break:break-all;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg2);margin:16px 0 0}
footer{max-width:480px;margin:0 auto;padding:0 20px 24px;color:var(--fg3);font-size:12px;display:flex;gap:14px;flex-wrap:wrap;justify-content:center}footer a{color:var(--fg3)}
.spin{width:28px;height:28px;border:3px solid var(--line);border-top-color:var(--ac);border-radius:50%;animation:s 1s linear infinite;margin:8px 0 20px}@keyframes s{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;
}

function stepHtml(s: FunnelStep, i: number, input: RenderInput): string {
  const sub = s.subtitle ? `<p class="sub">${esc(s.subtitle)}</p>` : "";
  const head = `<h1>${esc(s.title)}</h1>${sub}`;
  const attrs = `data-step="${esc(s.id)}" data-type="${s.type}" data-i="${i}" aria-label="${esc(s.title)}"`;
  switch (s.type) {
    case "question": {
      const role = s.multiple ? "" : ` role="radiogroup"`;
      const opts = s.options.map((o) => `<button type="button" class="opt" data-opt="${esc(o.id)}" data-next="${esc(o.next ?? "")}" ${s.multiple ? `aria-pressed="false"` : `role="radio" aria-checked="false"`}>${esc(o.label)}</button>`).join("");
      const cta = s.multiple ? `<button type="button" class="cta" data-continue disabled>${esc(s.button_label || "Continue")}</button>` : "";
      return `<section ${attrs}>${head}<div class="opts"${role} aria-label="${esc(s.title)}">${opts}</div>${cta}</section>`;
    }
    case "info": {
      const img = httpsOrNull(s.image_url) ? `<img class="img" src="${esc(s.image_url)}" alt="">` : "";
      return `<section ${attrs}>${img}${head}${s.body ? `<p class="body">${esc(s.body)}</p>` : ""}<button type="button" class="cta" data-continue>${esc(s.button_label || "Continue")}</button></section>`;
    }
    case "email": {
      const value = input.context?.email ? ` value="${esc(input.context.email)}"` : "";
      return `<section ${attrs}>${head}<label class="sr" for="email-${esc(s.id)}" style="position:absolute;left:-9999px">Email</label><input class="in" id="email-${esc(s.id)}" type="email" autocomplete="email" inputmode="email" placeholder="${esc(s.placeholder || "you@example.com")}"${value} data-email${s.required === false ? "" : " required"}><p class="err" data-err role="alert"></p><button type="button" class="cta" data-continue>${esc(s.button_label || "Continue")}</button></section>`;
    }
    case "paywall": {
      const pkgs = input.packages[s.offering ?? ""] ?? [];
      const first = pkgs.find((p) => p.id === s.highlight_package)?.id ?? pkgs[0]?.id;
      const feats = s.features?.length ? `<ul class="feat">${s.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : "";
      const cards = pkgs.length
        ? `<div class="pkgs" role="radiogroup" aria-label="Plans">${pkgs.map((p) => `<button type="button" class="pkg" role="radio" data-pkg="${esc(p.id)}" aria-checked="${p.id === first}"><span class="dot"></span><span><b>${esc(p.name)}${p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ""}</b><small>${esc(p.detail)}</small></span><span class="amt">${esc(p.price)}<small>${esc(p.period)}</small></span></button>`).join("")}</div>`
        : `<p class="note">No web products in this offering yet. Add a web product to the offering to sell it here.</p>`;
      const code = s.allow_codes ? `<details${input.context?.code ? " open" : ""}><summary>Have a discount code?</summary><div class="code"><input class="in" data-code autocomplete="off" aria-label="Discount code" placeholder="CODE"${input.context?.code ? ` value="${esc(input.context.code)}"` : ""}><button type="button" data-apply>Apply</button></div><p class="ok" data-code-msg role="status"></p></details>` : "";
      const canceled = input.context?.canceled ? `<p class="note">Checkout was cancelled. Pick a plan to try again.</p>` : "";
      return `<section ${attrs}>${canceled}${head}${feats}${cards}${code}<p class="err" data-err role="alert"></p><button type="button" class="cta" data-checkout${pkgs.length ? "" : " disabled"}>${esc(s.button_label || "Continue")}</button><p class="fine">Payments are processed securely by Stripe.${input.look.terms_url || input.look.privacy_url ? " By continuing you accept the terms below." : ""}</p></section>`;
    }
    case "success": {
      const ok = input.success;
      let actions = "";
      if (input.mode === "preview" || !ok) {
        actions = `<a class="cta" href="#" data-noop>Open the app</a>`;
      } else if (ok.status === "processing") {
        actions = `<div class="spin" aria-hidden="true"></div><p class="note" role="status">Your payment is processing. This page updates by itself.</p>`;
      } else if (ok.status === "identified") {
        actions = `<p class="note">Your purchase is linked to your account. Open the app to use it.</p>`;
      } else if (ok.redeem_url) {
        actions = `<a class="cta" href="${esc(ok.redeem_url)}" data-redeem>Open the app</a>`;
      }
      const stores = ok && ok.status !== "processing" && (httpsOrNull(ok.app_store_url) || httpsOrNull(ok.play_store_url))
        ? `<p class="fine" style="text-align:left;margin-top:20px">No app yet? Install it, then come back and tap Open the app.</p><div class="stores">${httpsOrNull(ok.app_store_url) ? `<a class="cta ghost" href="${esc(ok.app_store_url)}">App Store</a>` : ""}${httpsOrNull(ok.play_store_url) ? `<a class="cta ghost" href="${esc(ok.play_store_url)}">Google Play</a>` : ""}</div>` : "";
      const link = ok?.status === "paid" && ok.redeem_url && s.show_redemption !== false ? `<p class="link">Or open this link on your phone: ${esc(ok.redeem_url)}</p>` : "";
      return `<section ${attrs}>${head}${s.body ? `<p class="body">${esc(s.body)}</p>` : ""}${actions}${stores}${link}</section>`;
    }
  }
}

const SCRIPT = `(function(){
var D=JSON.parse(document.getElementById("rd-data").textContent);var steps=[].slice.call(document.querySelectorAll("section[data-step]"));
var cur=0,hist=[],answers={},email=D.ctx.email||"",sent={};
function idx(id){for(var i=0;i<steps.length;i++)if(steps[i].getAttribute("data-step")===id)return i;return -1}
function send(type,extra){if(D.mode!=="live"||!D.urls.events)return;var b=JSON.stringify(Object.assign({type:type,funnel_id:D.ctx.funnel_id,link_id:D.ctx.link_id,session_id:D.ctx.session_id,app_user_id:D.ctx.app_user_id,query:D.ctx.query},extra||{}));
try{if(navigator.sendBeacon&&navigator.sendBeacon(D.urls.events,new Blob([b],{type:"application/json"})))return}catch(e){}try{fetch(D.urls.events,{method:"POST",headers:{"content-type":"application/json"},body:b,keepalive:true})}catch(e){}}
function stepInfo(i){var s=steps[i];return{step_id:s.getAttribute("data-step"),step_type:s.getAttribute("data-type"),step_index:i}}
function show(i,push){if(i<0||i>=steps.length)return;if(push)hist.push(cur);steps[cur].classList.remove("on");cur=i;steps[i].classList.add("on");
var payable=steps.filter(function(s){return s.getAttribute("data-type")!=="success"}).length||1;var bar=document.querySelector(".bar i");if(bar)bar.style.width=Math.min(100,Math.round((i+1)/payable*100))+"%";
var back=document.querySelector(".back");if(back)back.style.visibility=hist.length&&steps[i].getAttribute("data-type")!=="success"?"visible":"hidden";
var k="v"+i;if(!sent[k]){sent[k]=1;send("step_viewed",stepInfo(i))}var f=steps[i].querySelector("input,button");if(f&&D.focus)try{f.focus({preventScroll:true})}catch(e){}D.focus=true;window.scrollTo(0,0)}
function next(from,target){var info=stepInfo(from);send("step_completed",Object.assign(info,{answer:answers[info.step_id]===undefined?null:answers[info.step_id]}));var t=target?idx(target):-1;show(t>=0?t:from+1,true)}
steps.forEach(function(s,i){var type=s.getAttribute("data-type"),id=s.getAttribute("data-step");
if(type==="question"){var multi=!!s.querySelector("[aria-pressed]");var opts=[].slice.call(s.querySelectorAll(".opt"));var c=s.querySelector("[data-continue]");
opts.forEach(function(o){o.addEventListener("click",function(){if(multi){o.setAttribute("aria-pressed",o.getAttribute("aria-pressed")==="true"?"false":"true");var sel=opts.filter(function(x){return x.getAttribute("aria-pressed")==="true"});answers[id]=sel.map(function(x){return x.textContent});if(c)c.disabled=!sel.length}
else{opts.forEach(function(x){x.setAttribute("aria-checked",x===o?"true":"false")});answers[id]=o.textContent;setTimeout(function(){next(i,o.getAttribute("data-next"))},180)}})});
if(c)c.addEventListener("click",function(){next(i,null)})}
else if(type==="email"){var inp=s.querySelector("[data-email]"),er=s.querySelector("[data-err]");s.querySelector("[data-continue]").addEventListener("click",function(){var v=inp.value.trim();
if((inp.required||v)&&!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v)){er.textContent="Enter a valid email address.";inp.focus();return}er.textContent="";email=v;answers[id]=v?"provided":"skipped";next(i,null)})}
else if(type==="paywall"){var pk=[].slice.call(s.querySelectorAll(".pkg"));pk.forEach(function(p){p.addEventListener("click",function(){pk.forEach(function(x){x.setAttribute("aria-checked",x===p?"true":"false")})})});
var code=s.querySelector("[data-code]"),msg=s.querySelector("[data-code-msg]"),er2=s.querySelector("[data-err]"),applied=null;
function sel(){var x=s.querySelector('.pkg[aria-checked="true"]');return x?x.getAttribute("data-pkg"):null}
var ap=s.querySelector("[data-apply]");if(ap)ap.addEventListener("click",function(){var v=code.value.trim();if(!v){msg.textContent="";applied=null;return}
if(D.mode!=="live"){msg.className="ok";msg.textContent="Codes are checked on the live page.";return}
fetch(D.urls.discount,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({project:D.ctx.project,slug:D.ctx.slug,package:sel(),code:v,app_user_id:D.ctx.app_user_id})}).then(function(r){return r.json()}).then(function(j){
if(j.valid){applied=v;msg.className="ok";msg.textContent=j.message}else{applied=null;msg.className="err";msg.textContent=j.message||"This code is not valid."}}).catch(function(){msg.className="err";msg.textContent="Could not check the code. Try again."})});
var btn=s.querySelector("[data-checkout]");btn.addEventListener("click",function(){var p=sel();if(!p){er2.textContent="Pick a plan.";return}answers[id]=p;
if(D.mode!=="live"){var si=steps.length-1;send("step_completed",stepInfo(i));show(si,true);return}
btn.disabled=true;er2.textContent="";send("step_completed",Object.assign(stepInfo(i),{answer:p}));
var v=code&&code.value.trim()?code.value.trim():null;
fetch(D.urls.checkout,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({project:D.ctx.project,slug:D.ctx.slug,package:p,code:v,email:email||null,app_user_id:D.ctx.app_user_id,session:D.ctx.session_id,answers:answers,query:D.ctx.query})})
.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){if(x.ok&&x.j.url){location.href=x.j.url}else{btn.disabled=false;er2.textContent=x.j.message||"Checkout could not start. Try again."}})
.catch(function(){btn.disabled=false;er2.textContent="Checkout could not start. Check your connection and try again."})})}
else{var cc=s.querySelector("[data-continue]");if(cc)cc.addEventListener("click",function(){next(i,null)})}
var n=s.querySelector("[data-noop]");if(n)n.addEventListener("click",function(e){e.preventDefault()})});
var b=document.querySelector(".back");if(b)b.addEventListener("click",function(){if(hist.length){var p=hist.pop();steps[cur].classList.remove("on");cur=p;steps[p].classList.add("on");show(p,false)}});
window.addEventListener("message",function(e){if(D.mode==="preview"&&e.data&&e.data.rdStep){var t=idx(e.data.rdStep);if(t>=0){hist=[];show(t,false)}}});
var start=D.start?idx(D.start):0;D.focus=false;if(D.mode==="live"&&!D.success)send("funnel_viewed",{});show(start<0?0:start,false);
if(D.success&&D.success.status==="processing")setTimeout(function(){location.reload()},2500);
var rd=document.querySelector("[data-redeem]");if(rd&&D.success&&D.success.deep_link&&/iPhone|iPad|Android/.test(navigator.userAgent)){rd.addEventListener("click",function(e){e.preventDefault();location.href=D.success.deep_link;setTimeout(function(){location.href=rd.href},1500)})}
})();`;

export function renderFunnelPage(input: RenderInput): string {
  const { funnel, look } = input;
  const nonce = input.nonce ? ` nonce="${esc(input.nonce)}"` : "";
  const logo = httpsOrNull(look.logo_url);
  const brand = `<div class="brand">${logo ? `<img src="${esc(logo)}" alt="${esc(look.app_name)}">` : esc(look.app_name)}</div>`;
  const sections = funnel.steps.map((s, i) => stepHtml(s, i, input)).join("");
  const legal = [
    httpsOrNull(look.terms_url) ? `<a href="${esc(look.terms_url)}">Terms</a>` : "",
    httpsOrNull(look.privacy_url) ? `<a href="${esc(look.privacy_url)}">Privacy</a>` : "",
    look.support_email && /^[^@\s<>"]+@[^@\s<>"]+$/.test(look.support_email) ? `<a href="mailto:${esc(look.support_email)}">Support</a>` : "",
  ].filter(Boolean).join("");
  const data = {
    mode: input.mode, start: input.startStepId ?? null, urls: input.urls ?? {}, success: input.success ?? null,
    ctx: { project: input.context?.project ?? null, slug: input.context?.slug ?? null, funnel_id: input.context?.funnel_id ?? null, link_id: input.context?.link_id ?? null, session_id: input.context?.session_id ?? null, app_user_id: input.context?.app_user_id ?? null, email: input.context?.email ?? null, query: input.context?.query ?? {} },
  };
  const title = input.title ?? look.app_name;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>` +
    `<style${nonce}>${css(funnel.theme)}</style></head><body>` +
    `<main class="wrap"><div class="top">${brand}<button type="button" class="back" style="visibility:hidden">Back</button></div><div class="bar" aria-hidden="true"><i style="width:0"></i></div>` +
    (input.notice ? `<p class="note" role="status">${esc(input.notice)}</p>` : "") + sections + `</main>` +
    (legal ? `<footer>${legal}</footer>` : "") +
    `<script type="application/json" id="rd-data">${scriptJson(data)}</script><script${nonce}>${SCRIPT}</script></body></html>`;
}

/** A plain message page in the same look (an expired link, an unknown page). */
export function renderMessagePage(o: { title: string; body: string; look?: PageLook; theme?: FunnelTheme; nonce?: string; action?: { label: string; href: string } | null }): string {
  const nonce = o.nonce ? ` nonce="${esc(o.nonce)}"` : "";
  const theme = o.theme ?? { background: "#FFFFFF", text: "#0A0A0A", accent: "#0A0A0A", button_text: "#FFFFFF", corner_radius: 0 };
  const action = o.action ? `<a class="cta" style="margin-top:24px" href="${esc(o.action.href)}">${esc(o.action.label)}</a>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(o.title)}</title><style${nonce}>${css(theme)}</style></head><body>` +
    `<main class="wrap"><div class="top"><div class="brand">${esc(o.look?.app_name ?? "")}</div></div><section class="on" style="padding-top:40px"><h1>${esc(o.title)}</h1><p class="body">${esc(o.body)}</p>${action}</section></main></body></html>`;
}
