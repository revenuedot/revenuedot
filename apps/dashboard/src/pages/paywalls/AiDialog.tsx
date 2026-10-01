/**
 * "Generate with AI": a prompt, the app name, up to three brand colours and the offering. The server asks its language
 * model (Workers AI on Cloud, OpenAI or Anthropic on self-host), repairs the answer into components the SDK decodes, and
 * returns it unsaved; the result shows in a phone preview and becomes a paywall (or replaces the editor's draft).
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { PaywallDoc } from "@revenuedot/core";
import { api } from "../../lib/api";
import { Dialog, Field, useToast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { errMsg, v2, type Offering } from "../catalog/lib";
import { Phone } from "./render";
import { OfferingField } from "./Paywalls";
import type { Generation, Paywall } from "./lib";

const EXAMPLES = [
  "A calm sleep and meditation app. Explain the 7-day free trial, yearly plan first.",
  "A photo editor for creators. Bold, dark, three benefits with icons.",
  "A language learning app with a limited-time 50% off yearly offer.",
];

export function AiDialog({ pid, offerings, onClose, onApply, fixedOffering, appName = "" }: {
  pid: string; offerings: Offering[]; onClose: () => void;
  /** Editor: use the result as the draft instead of creating a paywall. */
  onApply?: (doc: PaywallDoc, name: string | null) => void;
  fixedOffering?: Offering | null; appName?: string;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  const [app, setApp] = useState(appName);
  const [colors, setColors] = useState<string[]>([]);
  const [offering, setOffering] = useState(fixedOffering?.id ?? offerings[0]?.id ?? "");
  const [busy, setBusy] = useState<"gen" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<Generation | null>(null);
  const generate = async () => {
    if (prompt.trim().length < 3) { setErr("Describe the paywall in a few words."); return; }
    setBusy("gen"); setErr(null);
    try {
      const g = await api<Generation>(`${v2(pid)}/paywalls/generate`, { method: "POST", json: { prompt: prompt.trim(), ...(app.trim() ? { app_name: app.trim() } : {}), ...(colors.length ? { brand_colors: colors } : {}), ...(offering ? { offering_id: offering } : {}) } });
      setOut(g);
    } catch (e) { setErr(errMsg(e)); }
    setBusy(null);
  };
  const doc = out ? { components_config: out.components_config, components_localizations: out.components_localizations, default_locale: out.default_locale } as PaywallDoc : null;
  const use = async () => {
    if (!doc || !out) return;
    if (onApply) { onApply(doc, out.name); onClose(); return; }
    setBusy("save"); setErr(null);
    try {
      const p = await api<Paywall>(`${v2(pid)}/paywalls`, { method: "POST", json: { ...(offering ? { offering_id: offering } : {}), name: out.name ?? "AI paywall", ...doc } });
      toast("Paywall created from the AI draft"); nav(`/projects/${pid}/paywalls/${p.id}`);
    } catch (e) { setErr(errMsg(e)); setBusy(null); }
  };
  return (
    <Dialog title="Generate a paywall with AI" onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      {out && <button type="button" className="btn btn-line" disabled={!!busy} onClick={generate}><Icon name="refresh" />Try again</button>}
      {out ? <button type="button" className="btn btn-dark" disabled={!!busy} onClick={use}>{busy === "save" ? "Creating…" : onApply ? "Use as draft" : "Create paywall"}</button>
        : <button type="button" className="btn btn-dark" disabled={!!busy} onClick={generate}><Icon name="spark" />{busy === "gen" ? "Generating…" : "Generate"}</button>}
    </>}>
      <div className="pw-ai">
        <div className="pw-ai-form">
          <Field label="Describe the paywall" htmlFor="ai-prompt" hint="Who the app is for, the offer (trial, discount) and the tone.">
            <textarea id="ai-prompt" className="textarea" rows={5} maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={EXAMPLES[0]} />
          </Field>
          <div className="pw-ai-ex">{EXAMPLES.map((x) => <button key={x} type="button" className="chip" onClick={() => setPrompt(x)}>{x.split(".")[0]}</button>)}</div>
          <Field label="App name" htmlFor="ai-app"><input id="ai-app" className="input" value={app} maxLength={80} onChange={(e) => setApp(e.target.value)} placeholder="Optional" /></Field>
          <div className="field">
            <label>Brand colours</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {colors.map((c, i) => (
                <span key={i} className="pw-swatch">
                  <input type="color" aria-label={i === 0 ? "Accent colour" : i === 1 ? "Background colour" : "Text colour"} value={c} onChange={(e) => setColors(colors.map((x, j) => (j === i ? e.target.value : x)))} />
                  {i === colors.length - 1 && <button type="button" className="ib" aria-label="Remove colour" onClick={() => setColors(colors.slice(0, -1))}><Icon name="close" /></button>}
                </span>
              ))}
              {colors.length < 3 && <button type="button" className="btn btn-ghost" onClick={() => setColors([...colors, ["#2563eb", "#ffffff", "#111111"][colors.length]!])}><Icon name="plus" />{["Accent", "Background", "Text"][colors.length]}</button>}
            </div>
            <span className="hint">Optional. Accent first, then background and text; without them the model picks.</span>
          </div>
          {!fixedOffering && offerings.length > 0 && <OfferingField id="ai-offering" offerings={offerings} value={offering} onChange={setOffering} />}
          {err && <div className="banner err" role="alert">{err}</div>}
          {out && (
            <div className="pw-ai-notes" aria-label="What was fixed">
              <span className="label">Draft from {out.provider} · {out.model}</span>
              {out.fixes.length ? <ul>{out.fixes.map((f) => <li key={f}>{f}</li>)}</ul> : <p className="subtle">The model's answer needed no repairs.</p>}
            </div>
          )}
        </div>
        <div className="pw-ai-prev">
          {doc ? <Phone doc={doc} width={260} label="Generated paywall preview" /> : (
            <div className="pw-ai-wait">{busy === "gen" ? <><span className="live" />Writing your paywall…</> : <><Icon name="phone" />The preview shows here.</>}</div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
