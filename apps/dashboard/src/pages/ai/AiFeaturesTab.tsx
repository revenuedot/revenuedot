import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "../../components/ui";
import { api, fmt } from "../../lib/api";
import { aiBase, useAiStatus, type AiStatus } from "./data";

/**
 * Project settings → AI features (prd/ai-assistant/PRD.md §3): what RevenueDot AI may do in this project. Read and write
 * with permission (every change asks first), read only, or disabled. A collaborator's role limits it further. Admins
 * change it; everyone sees it, with the model in use and today's usage.
 */
const OPTIONS: { value: AiStatus["access"]; label: string; text: string }[] = [
  { value: "read_write", label: "Read and write with permission", text: "RevenueDot AI reads metrics, charts, customers and the catalog, and can grant access, create products, change offerings and experiments and replay webhooks. Every change shows an Approve and Deny card first, and is recorded in the audit log." },
  { value: "read_only", label: "Read only", text: "RevenueDot AI answers questions from your data but cannot change anything." },
  { value: "disabled", label: "Disabled", text: "Nobody in this project can use RevenueDot AI. Existing conversations are kept." },
];

const ROLE_LIMITS = [
  ["Admin", "Everything the setting allows."],
  ["Developer", "Everything the setting allows."],
  ["Viewer", "Read only, whatever the setting."],
];

export function AiFeaturesTab({ pid }: { pid: string }) {
  const status = useAiStatus(pid);
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  // The choice shows at once; it goes back if the save fails.
  const [choice, setChoice] = useState<AiStatus["access"] | null>(null);
  const s = status.data;
  if (status.isLoading) return <div className="panel pb subtle">Loading…</div>;
  if (!s) return <div className="banner err" role="alert">The AI settings could not be loaded.</div>;
  const admin = s.role === "admin";
  const set = async (access: AiStatus["access"]) => {
    if (access === (choice ?? s.access)) return;
    setChoice(access);
    setSaving(access);
    try {
      await api(`${aiBase(pid)}/settings`, { method: "POST", json: { access } });
      await qc.invalidateQueries({ queryKey: ["ai-status", pid] });
      toast("AI features saved.");
    } catch (e) { setChoice(null); toast(e instanceof Error ? e.message : "The setting could not be saved."); } finally { setSaving(null); }
  };
  return (
    <div className="stack" data-testid="ai-features">
      <section className="panel">
        <div className="ph"><b>What RevenueDot AI may do in this project</b></div>
        <div className="pb stack">
          <div className="ai-options" role="radiogroup" aria-label="RevenueDot AI access">
            {OPTIONS.map((o) => (
              <label key={o.value} className={`ai-option${(choice ?? s.access) === o.value ? " on" : ""}${admin ? "" : " ro"}`}>
                <input type="radio" name="ai-access" value={o.value} checked={(choice ?? s.access) === o.value} disabled={!admin || !!saving} onChange={() => void set(o.value)} />
                <span className="b"><b>{o.label}</b><span>{o.text}</span></span>
              </label>
            ))}
          </div>
          {!admin && <p className="section-sub">Only project admins can change this.</p>}
        </div>
      </section>

      <section className="panel">
        <div className="ph"><b>Limited by role</b></div>
        <div className="pb">
          <table className="tbl"><tbody>{ROLE_LIMITS.map(([r, t]) => <tr key={r}><td><b>{r}</b></td><td>{t}</td></tr>)}</tbody></table>
          <p className="section-sub">Your role: <b>{s.role}</b>. {s.can_write ? "You can approve changes." : s.reason}</p>
        </div>
      </section>

      <section className="panel">
        <div className="ph"><b>Model and usage</b></div>
        <div className="pb stack">
          {s.configured
            ? <p>Model: <span className="mono">{s.provider} · {s.model}</span> · conversations run {s.runtime === "durable_object" ? "in Durable Objects (RevenueDot Cloud)" : "on this server (Postgres)"}.</p>
            : <p>No model is configured on this server. Set <code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code> and restart.</p>}
          {s.usage && (
            <table className="tbl">
              <thead><tr><th>Today (UTC)</th><th className="num">Questions</th><th className="num">Tokens</th></tr></thead>
              <tbody>
                <tr><td>You</td><td className="num">{fmt.int(s.usage.user.turns)} / {fmt.int(s.caps.userTurnsPerDay)}</td><td className="num">{fmt.int(s.usage.user.tokens)} / {fmt.int(s.caps.userTokensPerDay)}</td></tr>
                <tr><td>This project</td><td className="num">{fmt.int(s.usage.project.turns)} / {fmt.int(s.caps.projectTurnsPerDay)}</td><td className="num">{fmt.int(s.usage.project.tokens)} / {fmt.int(s.caps.projectTokensPerDay)}</td></tr>
              </tbody>
            </table>
          )}
          <p className="section-sub">Changes the assistant makes show in <Link className="ul" to={`/projects/${pid}/settings/audit-logs`}>Audit logs</Link> as "RevenueDot AI on behalf of" the person who approved them.</p>
        </div>
      </section>
    </div>
  );
}
