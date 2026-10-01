/**
 * Lifecycle / Customer Center: /projects/:projectId/lifecycle/customer-center
 * Edits the configuration the SDK's Customer Center screen loads: the support email, three display switches and the
 * titles of the management and no-active screens. Everything else keeps the built-in default; "Reset" clears the overrides.
 * `GET`/`POST /v2/projects/{id}/customer_center_config`.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { Check, ConfirmDialog, Disclosure, Field, PageHead, useProjectId, useToast } from "../../components/ui";
import { errMsg, v2 } from "../catalog/lib";

type Cfg = Record<string, any>;
interface Resp { customer_center: Cfg; overrides: Cfg | null }

export function CustomerCenterPage() {
  const pid = useProjectId();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["customer-center", pid], queryFn: () => api<Resp>(`${v2(pid)}/customer_center_config`), enabled: !!pid });
  const [email, setEmail] = useState("");
  const [history, setHistory] = useState(true);
  const [details, setDetails] = useState(true);
  const [warn, setWarn] = useState(false);
  const [mTitle, setMTitle] = useState("");
  const [mSub, setMSub] = useState("");
  const [nTitle, setNTitle] = useState("");
  const [nSub, setNSub] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    const c = q.data?.customer_center;
    if (!c) return;
    setEmail(c.support?.email ?? ""); setHistory(!!c.support?.display_purchase_history_link); setDetails(!!c.support?.display_user_details_section); setWarn(!!c.support?.should_warn_customer_to_update);
    setMTitle(c.screens?.MANAGEMENT?.title ?? ""); setMSub(c.screens?.MANAGEMENT?.subtitle ?? ""); setNTitle(c.screens?.NO_ACTIVE?.title ?? ""); setNSub(c.screens?.NO_ACTIVE?.subtitle ?? "");
  }, [q.data]);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { setErr("Enter the email address customers should write to."); return; }
    if (!mTitle.trim() || !nTitle.trim()) { setErr("Each screen needs a title."); return; }
    setBusy(true); setErr(null);
    const overrides = {
      ...(q.data?.overrides ?? {}),
      support: { ...(q.data?.overrides?.support ?? {}), email: email.trim(), display_purchase_history_link: history, display_user_details_section: details, should_warn_customer_to_update: warn },
      screens: {
        ...(q.data?.overrides?.screens ?? {}),
        MANAGEMENT: { ...(q.data?.overrides?.screens?.MANAGEMENT ?? {}), title: mTitle.trim(), subtitle: mSub.trim() },
        NO_ACTIVE: { ...(q.data?.overrides?.screens?.NO_ACTIVE ?? {}), title: nTitle.trim(), subtitle: nSub.trim() },
      },
    };
    try { await api(`${v2(pid)}/customer_center_config`, { method: "POST", json: { customer_center: overrides } }); await qc.invalidateQueries({ queryKey: ["customer-center", pid] }); toast("Customer Center saved"); }
    catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  }

  return (
    <Shell title="Customer Center">
      <div className="page narrow">
        <PageHead title="Customer Center" sub="The screen where customers manage their subscription from inside your app. The SDK loads this configuration each time it opens." />
        {q.isError ? <div className="banner err" role="alert">The configuration could not be loaded: {errMsg(q.error)}</div> : q.isLoading ? <div className="panel pb subtle">Loading…</div> : (
          <form className="panel pb" onSubmit={save} noValidate style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Field label="Support email" htmlFor="cc-email" hint="Where the Contact support button sends mail.">
              <input id="cc-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Check checked={history} onChange={setHistory} label="Show a link to the purchase history" />
            <Check checked={details} onChange={setDetails} label="Show the customer's account details" />
            <Check checked={warn} onChange={setWarn} label="Ask customers on old app versions to update" hint="Shown before they contact support." />
            <Disclosure title="Screen texts" sub="Management screen (active subscription) and the no-active screen" defaultOpen>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Field label="Management title" htmlFor="cc-mt"><input id="cc-mt" className="input" value={mTitle} onChange={(e) => setMTitle(e.target.value)} /></Field>
                <Field label="Management subtitle" htmlFor="cc-ms"><input id="cc-ms" className="input" value={mSub} onChange={(e) => setMSub(e.target.value)} /></Field>
                <Field label="No-active title" htmlFor="cc-nt"><input id="cc-nt" className="input" value={nTitle} onChange={(e) => setNTitle(e.target.value)} /></Field>
                <Field label="No-active subtitle" htmlFor="cc-ns"><input id="cc-ns" className="input" value={nSub} onChange={(e) => setNSub(e.target.value)} /></Field>
              </div>
            </Disclosure>
            {err && <div className="banner err" role="alert">{err}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
              {q.data?.overrides && <button type="button" className="btn btn-line" onClick={() => setResetting(true)}>Reset to default</button>}
            </div>
          </form>
        )}
      </div>
      {resetting && (
        <ConfirmDialog title="Reset the Customer Center?" confirmLabel="Reset" danger onClose={() => setResetting(false)} onConfirm={async () => {
          await api(`${v2(pid)}/customer_center_config`, { method: "POST", json: { customer_center: null } });
          await qc.invalidateQueries({ queryKey: ["customer-center", pid] }); toast("Back to the default");
        }}><p>Your changes are removed and the built-in screens are used.</p></ConfirmDialog>
      )}
    </Shell>
  );
}
