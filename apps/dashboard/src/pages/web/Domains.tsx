/**
 * Project settings → Domains (prd/web-billing/PRD.md §7): where purchase links and funnels live. The project's address on
 * RevenueDot's domain (its slug, editable), and a custom domain with the two DNS records to add and a Verify button that
 * reads them through DNS over HTTPS.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CopyButton, CopyField, Field, StatusLine, useToast } from "../../components/ui";
import { api, fmt } from "../../lib/api";
import { v2 } from "../catalog/lib";
import { apiError } from "./parts";
import { useDomain, useRefreshWeb, webKey, type Domain } from "./lib";

export function DomainsTab({ pid }: { pid: string }) {
  const d = useDomain(pid);
  if (d.isError) return <div className="banner err" role="alert">The domain settings could not be loaded: {apiError(d.error).message}</div>;
  if (!d.data) return <div className="panel pb subtle">Loading…</div>;
  return <DomainForms pid={pid} d={d.data} />;
}

function DomainForms({ pid, d }: { pid: string; d: Domain }) {
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = useRefreshWeb(pid);
  const [slug, setSlug] = useState(d.slug);
  const [custom, setCustom] = useState(d.custom_domain ?? "");
  const [busy, setBusy] = useState<"slug" | "custom" | "verify" | "remove" | null>(null);
  const [err, setErr] = useState<{ slug?: string; custom?: string; verify?: string }>({});
  useEffect(() => { setSlug(d.slug); setCustom(d.custom_domain ?? ""); }, [d.slug, d.custom_domain]);
  const put = async (json: Record<string, unknown>, what: "slug" | "custom" | "remove") => {
    setBusy(what); setErr({});
    try {
      const r = await api<Domain>(`${v2(pid)}/web_domain`, { method: "PUT", json });
      qc.setQueryData([...webKey(pid), "domain"], r);
      await refresh();
      toast(what === "slug" ? "Address saved. Existing links now use it." : what === "remove" ? "Custom domain removed." : "Custom domain saved. Add the DNS records, then verify.");
    } catch (e) {
      // The API names the field ("slug: must be …"); under the field, say which value is wrong in words.
      const { message, param } = apiError(e);
      const bare = param && message.startsWith(`${param}: `) ? message.slice(param.length + 2) : null;
      setErr({ [what === "slug" ? "slug" : "custom"]: bare ? `${what === "slug" ? "The address" : "The domain"} ${bare}.`.replace(/\.\.$/, ".") : message });
    }
    setBusy(null);
  };
  const verify = async () => {
    setBusy("verify"); setErr({});
    try {
      const r = await api<Domain>(`${v2(pid)}/web_domain/actions/verify`, { method: "POST" });
      qc.setQueryData([...webKey(pid), "domain"], r);
      await refresh();
      toast(r.status === "verified" ? "Domain verified." : "The DNS records are not there yet.");
    } catch (e) { setErr({ verify: apiError(e).message }); }
    setBusy(null);
  };
  const saveSlug = (e: FormEvent) => { e.preventDefault(); if (slug.trim() && slug.trim() !== d.slug) void put({ slug: slug.trim().toLowerCase() }, "slug"); };
  const saveCustom = (e: FormEvent) => { e.preventDefault(); const v = custom.trim().toLowerCase(); if (v && v !== d.custom_domain) void put({ custom_domain: v }, "custom"); };
  const tone = d.status === "verified" ? "ok" : d.status === "failed" ? "bad" : "idle";
  return (
    <div className="stack">
      <section className="panel" aria-labelledby="dm-rd-h">
        <div className="ph"><b id="dm-rd-h">RevenueDot domain</b></div>
        <form className="pb stack" onSubmit={saveSlug}>
          <p className="section-sub">Purchase links and funnels live under this address until you verify a custom domain.</p>
          <Field label="Project address" htmlFor="dm-slug" error={err.slug} hint="3 to 40 lower-case letters, digits or dashes. Changing it changes every link you shared.">
            <div className="hrow wb-slug"><span className="subtle mono">{d.pay_base}/</span><input id="dm-slug" className="input mono" spellCheck={false} autoCapitalize="off" value={slug} aria-invalid={!!err.slug} onChange={(e) => setSlug(e.target.value)} />
              <button type="submit" className="btn btn-line" disabled={busy === "slug" || !slug.trim() || slug.trim() === d.slug}>{busy === "slug" ? "Saving…" : "Save"}</button></div>
          </Field>
          <div className="field"><span className="flabel">Base URL in use</span><CopyField value={d.base} label="base URL" /></div>
        </form>
      </section>

      <section className="panel" aria-labelledby="dm-custom-h">
        <div className="ph"><b id="dm-custom-h">Custom domain</b>{d.custom_domain && <span className="link">{d.status === "verified" ? "Verified" : d.status === "failed" ? "Not verified" : "Pending"}</span>}</div>
        <div className="pb stack">
          <form className="stack" onSubmit={saveCustom}>
            <Field label="Domain" htmlFor="dm-custom" error={err.custom} hint="A subdomain you own, such as pay.yourapp.com. Pages then live at https://pay.yourapp.com/<page>.">
              <div className="hrow wb-slug"><input id="dm-custom" className="input mono" spellCheck={false} autoCapitalize="off" placeholder="pay.yourapp.com" value={custom} aria-invalid={!!err.custom} onChange={(e) => setCustom(e.target.value)} />
                <button type="submit" className="btn btn-dark" disabled={busy === "custom" || !custom.trim() || custom.trim().toLowerCase() === d.custom_domain}>{busy === "custom" ? "Saving…" : "Save domain"}</button>
                {d.custom_domain && <button type="button" className="btn btn-line" disabled={!!busy} onClick={() => put({ custom_domain: null }, "remove")}>Remove</button>}</div>
            </Field>
          </form>
          {d.custom_domain && (
            <>
              <p className="section-sub">Add these two records at your DNS provider, then press Verify. DNS changes can take a few minutes to show.</p>
              <div className="tbl wb-dns">
                <table aria-label="DNS records">
                  <thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead>
                  <tbody>
                    {d.dns.map((r) => (
                      <tr key={r.type}>
                        <td className="mono">{r.type}</td>
                        <td className="id"><span className="hrow">{r.name}<CopyButton value={r.name} label={`Copy ${r.type} name`} /></span></td>
                        <td className="id"><span className="hrow"><span className="wb-url" title={r.value}>{r.value}</span><CopyButton value={r.value} label={`Copy ${r.type} value`} /></span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="hrow between">
                <StatusLine tone={tone}>
                  {d.status === "verified" ? <>Verified {fmt.ago(d.verified_at)}. Pages answer on <b>{d.custom_domain}</b>.</>
                    : d.status === "failed" ? <>Not verified{d.checked_at ? ` (checked ${fmt.ago(d.checked_at)})` : ""}: {d.error ?? "the records were not found."}</>
                    : "Pending: add the records, then verify."}
                </StatusLine>
                <button type="button" className="btn btn-line" disabled={!!busy} onClick={verify}>{busy === "verify" ? "Checking DNS…" : "Verify"}</button>
              </div>
              {err.verify && <div className="banner err" role="alert">{err.verify}</div>}
            </>
          )}
          {d.cloud_note && <div className="banner warn" role="note">{d.cloud_note}</div>}
        </div>
      </section>
    </div>
  );
}
