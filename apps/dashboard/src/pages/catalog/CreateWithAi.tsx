/**
 * "Create with AI" in the New product and New offering menus (prd/catalog/PRD.md "Create with AI"): the user says what to
 * create, and a RevenueDot AI conversation opens with that request. The assistant reads the apps and products, drafts
 * everything in one create-products or create-offering call, and nothing is written until the user approves its card.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Dialog, Field } from "../../components/ui";
import { Icon } from "../../components/icons";
import { aiBase, type Conversation, type PendingMessage } from "../ai/data";
import { errMsg, type App } from "./lib";

const COPY = {
  product: {
    title: "Create products with AI", label: "What do you sell?", prefix: "Draft products for this project and create them after I approve:",
    examples: ["Pro: $9.99 monthly and $59.99 yearly on iOS and Android", "A $99.99 lifetime unlock on the Test Store", "Premium $4.99 weekly with a 3-day trial, attached to premium"],
    placeholder: "A monthly and a yearly Pro subscription on iOS and Android, $9.99 and $59.99, attached to pro",
  },
  offering: {
    title: "Create an offering with AI", label: "What should the offering show?", prefix: "Draft an offering for this project and create it after I approve:",
    examples: ["An offering called default with every Pro plan, and make it current", "An offering called sale with the yearly plan only", "An offering called onboarding with monthly and lifetime"],
    placeholder: "An offering called default with the monthly and yearly Pro plans, and make it current",
  },
} as const;

export function CreateWithAiDialog({ pid, what, apps, onClose }: { pid: string; what: "product" | "offering"; apps: App[]; onClose: () => void }) {
  const c = COPY[what];
  const nav = useNavigate();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    const t = text.trim();
    if (!t) { setError(`Describe the ${what === "product" ? "products" : "offering"} to create, such as "${c.examples[0]}".`); return; }
    setBusy(true); setError(null);
    try {
      const conv = await api<Conversation>(`${aiBase(pid)}/conversations`, { method: "POST", json: { title: what === "product" ? "New products" : "New offering" } });
      await qc.invalidateQueries({ queryKey: ["ai-conversations", pid] });
      const pending: PendingMessage = { text: `${c.prefix} ${t}`, files: [] };
      nav(`/projects/${pid}/ai/${conv.id}`, { state: { pending } });
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Dialog title={c.title} onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="cwa-form" className="btn btn-dark" disabled={busy}><Icon name="spark" />{busy ? "Opening…" : "Draft with RevenueDot AI"}</button>
    </>}>
      <form id="cwa-form" className="cwa" noValidate onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <p className="cat-lead">RevenueDot AI reads your apps{what === "offering" ? " and products" : ""}, drafts {what === "product" ? "the products" : "the offering with its packages"}, and shows you everything it will create. Nothing changes until you approve.</p>
        <Field label={c.label} htmlFor="cwa-text" error={error} hint={what === "product" ? `Apps in this project: ${apps.map((a) => a.name).join(", ") || "none yet"}.` : "Name the offering and the plans its packages should hold."}>
          <textarea id="cwa-text" className="input cwa-text" rows={4} autoFocus placeholder={c.placeholder} aria-invalid={!!error} value={text}
            onChange={(e) => { setText(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void go(); } }} />
        </Field>
        <div className="cwa-ex" aria-label="Examples">
          {c.examples.map((x) => <button key={x} type="button" className="cwa-chip" onClick={() => { setText(x); setError(null); }}>{x}</button>)}
        </div>
      </form>
    </Dialog>
  );
}
