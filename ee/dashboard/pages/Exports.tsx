// RevenueDot Enterprise (ee/LICENSE). Organization settings, Compliance exports tab: signed audit log and access review
// downloads, and how to check a signature.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../../apps/dashboard/src/lib/api";
import { CodeBlock, CopyField, Field, KeyValue, Segmented, Tag } from "../../../apps/dashboard/src/components/ui";
import { base, errMsg, type Overview } from "../lib";

interface Done { kind: string; file: string; sha256: string; signature: string | null; keyId: string | null; rows: string }

export function ExportsTab({ org }: { org: Overview }) {
  const key = useQuery({ queryKey: ["export-key", org.id], queryFn: () => api<{ public_key: string | null; key_id: string | null; signs: boolean }>(`${base(org.id)}/exports/public_key`) });
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const download = async (kind: "audit_logs" | "access_review") => {
    setBusy(kind); setError(null);
    const q = new URLSearchParams({ format });
    if (kind === "audit_logs" && from) q.set("start_time", String(new Date(`${from}T00:00:00Z`).getTime()));
    if (kind === "audit_logs" && to) q.set("end_time", String(new Date(`${to}T00:00:00Z`).getTime() + 86400_000));
    try {
      const res = await fetch(`${base(org.id)}/exports/${kind}?${q}`, { credentials: "same-origin" });
      if (!res.ok) { const b = await res.json().catch(() => null) as { message?: string } | null; throw new ApiError(res.status, b?.message ?? `Export failed (${res.status})`, b); }
      const blob = await res.blob();
      const file = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `${kind}.${format}`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = file; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      const text = await blob.text();
      setDone({ kind, file, sha256: res.headers.get("x-revenuedot-content-sha256") ?? "", signature: res.headers.get("x-revenuedot-signature")?.replace(/^ed25519=/, "") ?? null, keyId: res.headers.get("x-revenuedot-key-id"), rows: format === "csv" ? String(Math.max(0, text.trim().split("\r\n").length - 1)) : String((JSON.parse(text) as { row_count: number }).row_count) });
    } catch (e) { setError(errMsg(e)); } finally { setBusy(null); }
  };
  const verify = key.data?.public_key ? `// Node 20+: node verify.mjs ${done?.file ?? "<file>"} <signature>
import { readFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
const raw = Buffer.from("${key.data.public_key}", "base64");
const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
console.log(verify(null, readFileSync(process.argv[2]), key, Buffer.from(process.argv[3], "base64")) ? "valid" : "INVALID");` : "";
  return (
    <div className="stack">
      <section className="panel">
        <div className="ph"><b>Download</b><Segmented label="File format" value={format} onChange={setFormat} options={[{ value: "csv", label: "CSV" }, { value: "json", label: "JSON" }]} /></div>
        <div className="pb stack">
          <div className="cards">
            <div className="card">
              <div className="card-h"><b>Audit log</b></div>
              <p>Every organization and project change with who made it, oldest first. Up to 200,000 rows per file.</p>
              <div className="hrow">
                <Field label="From" htmlFor="ex-from"><input id="ex-from" className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
                <Field label="To" htmlFor="ex-to"><input id="ex-to" className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
              </div>
              <div><button type="button" className="btn btn-dark" disabled={!!busy} onClick={() => void download("audit_logs")}>{busy === "audit_logs" ? "Preparing…" : "Download audit log"}</button></div>
            </div>
            <div className="card">
              <div className="card-h"><b>Access review</b></div>
              <p>Who can open each project, with which role and permissions, how they got it, and how they sign in. For quarterly access reviews.</p>
              <div><button type="button" className="btn btn-dark" disabled={!!busy} onClick={() => void download("access_review")}>{busy === "access_review" ? "Preparing…" : "Download access review"}</button></div>
            </div>
          </div>
          {error && <div className="banner err" role="alert">{error}</div>}
          {done && (
            <KeyValue rows={[
              ["File", <code key="f">{done.file}</code>], ["Rows", <span key="r" className="mono">{done.rows}</span>],
              ["SHA-256", <code key="h" style={{ overflowWrap: "anywhere" }}>{done.sha256}</code>],
              ["Signature (Ed25519)", done.signature ? <code key="s" style={{ overflowWrap: "anywhere" }}>{done.signature}</code> : <Tag tone="down">Not signed</Tag>],
            ]} />
          )}
        </div>
      </section>
      <section className="panel">
        <div className="ph"><b>Signing key</b>{key.data && <Tag tone={key.data.signs ? "up" : "down"}>{key.data.signs ? "Signing" : "Not signing"}</Tag>}</div>
        <div className="pb stack">
          {key.data?.public_key ? <>
            <p className="section-sub">Each file is signed with Ed25519 over its exact bytes. The signature is in the <code className="mono">X-RevenueDot-Signature</code> response header and shown above after a download. Give auditors this public key.</p>
            <Field label="Public key (raw, base64)" htmlFor="pk"><CopyField value={key.data.public_key} label="public key" /></Field>
            <CodeBlock label="verify.mjs" code={verify} />
          </> : key.data && <p className="section-sub">This server has no signing key, so exports are not signed. Set <code className="mono">REVENUEDOT_SIGNING_KEY</code> (or <code className="mono">REVENUEDOT_ENCRYPTION_KEY</code>) and restart.</p>}
        </div>
      </section>
    </div>
  );
}
