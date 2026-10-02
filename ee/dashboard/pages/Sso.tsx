// RevenueDot Enterprise (ee/LICENSE). Organization settings, Single sign-on tab: SAML 2.0 and OpenID Connect
// connections, verified domains and enforcement.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmt, type List } from "../../../apps/dashboard/src/lib/api";
import { Check, ConfirmDialog, CopyField, Dialog, EmptyState, Field, Menu, Segmented, StatusLine, Switch, Tag, useToast } from "../../../apps/dashboard/src/components/ui";
import { Icon } from "../../../apps/dashboard/src/components/icons";
import { base, errMsg, isAdmin, type Overview } from "../lib";

interface Connection {
  id: string; kind: "saml" | "oidc"; name: string; enabled: boolean; jit: boolean; created_at: number;
  saml?: { idp_entity_id: string; idp_sso_url: string; idp_certificates: string[]; allow_idp_initiated: boolean; email_attribute: string | null; first_name_attribute: string | null; last_name_attribute: string | null; groups_attribute: string | null };
  oidc?: { issuer: string; client_id: string; scopes: string[]; groups_claim: string | null; has_client_secret: boolean };
  sp: { entity_id?: string; acs_url?: string; metadata_url?: string; redirect_uri?: string; start_url: string };
}
interface Domain { domain: string; verified: boolean; verified_at: number | null; txt_record: { type: string; name: string; value: string }; last_checked_at: number | null; last_error: string | null }

function ConnectionDialog({ org, conn, onClose }: { org: Overview; conn: Connection | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<"saml" | "oidc">(conn?.kind ?? "saml");
  const [name, setName] = useState(conn?.name ?? "");
  const [jit, setJit] = useState(conn?.jit ?? true);
  const [samlMode, setSamlMode] = useState<"metadata" | "manual">(conn ? "manual" : "metadata");
  const [metadata, setMetadata] = useState("");
  const [entity, setEntity] = useState(conn?.saml?.idp_entity_id ?? "");
  const [ssoUrl, setSsoUrl] = useState(conn?.saml?.idp_sso_url ?? "");
  const [cert, setCert] = useState(conn?.saml?.idp_certificates.join("\n\n") ?? "");
  const [idpInit, setIdpInit] = useState(conn?.saml?.allow_idp_initiated ?? false);
  const [groupsAttr, setGroupsAttr] = useState(conn?.saml?.groups_attribute ?? conn?.oidc?.groups_claim ?? "");
  const [issuer, setIssuer] = useState(conn?.oidc?.issuer ?? "");
  const [clientId, setClientId] = useState(conn?.oidc?.client_id ?? "");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Connection | null>(null);
  const certs = cert.split(/(?=-----BEGIN CERTIFICATE-----)/).map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    setBusy(true); setError(null);
    const saml = kind === "saml" ? (samlMode === "metadata" && metadata.trim()
      ? { metadata_xml: metadata, allow_idp_initiated: idpInit, groups_attribute: groupsAttr.trim() || null }
      : { idp_entity_id: entity.trim(), idp_sso_url: ssoUrl.trim(), idp_certificates: certs, allow_idp_initiated: idpInit, groups_attribute: groupsAttr.trim() || null }) : undefined;
    const oidc = kind === "oidc" ? { issuer: issuer.trim(), client_id: clientId.trim(), ...(secret ? { client_secret: secret } : {}), groups_claim: groupsAttr.trim() || null } : undefined;
    try {
      const r = await api<Connection>(conn ? `${base(org.id)}/sso/connections/${conn.id}` : `${base(org.id)}/sso/connections`, { method: "POST", json: { ...(conn ? {} : { kind }), name: name.trim() || (kind === "saml" ? "SAML" : "OpenID Connect"), jit, saml, oidc } });
      await Promise.all([qc.invalidateQueries({ queryKey: ["sso-connections", org.id] }), qc.invalidateQueries({ queryKey: ["org", org.id] })]);
      toast(conn ? "Connection saved." : "Connection created. Turn it on when your identity provider is set up.");
      if (conn) onClose(); else { setSaved(r); setBusy(false); }
    } catch (e) { setError(errMsg(e)); setBusy(false); }
  };
  if (saved) return <SpValues conn={saved} onClose={onClose} />;
  return (
    <Dialog title={conn ? `Edit ${conn.name}` : "New single sign-on connection"} onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" disabled={busy} onClick={save}>{busy ? "Saving…" : conn ? "Save" : "Create connection"}</button>
    </>}>
      <div className="stack">
        {!conn && <Segmented label="Protocol" value={kind} onChange={setKind} options={[{ value: "saml", label: "SAML 2.0" }, { value: "oidc", label: "OpenID Connect" }]} />}
        <Field label="Name" htmlFor="sso-name" hint="Shown to admins only, e.g. Okta or Entra ID."><input id="sso-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        {kind === "saml" && <>
          {!conn && <Segmented label="Identity provider details" value={samlMode} onChange={setSamlMode} options={[{ value: "metadata", label: "Paste metadata XML" }, { value: "manual", label: "Enter by hand" }]} />}
          {samlMode === "metadata" && !conn
            ? <Field label="Identity provider metadata (XML)" htmlFor="sso-meta" hint="From Okta (Sign On, Metadata URL), Entra ID (Federation Metadata XML) or Google Workspace (Download metadata)."><textarea id="sso-meta" className="textarea mono" rows={6} value={metadata} onChange={(e) => setMetadata(e.target.value)} placeholder="<EntityDescriptor …>" /></Field>
            : <>
              <Field label="Identity provider entity ID (issuer)" htmlFor="sso-entity"><input id="sso-entity" className="input mono" value={entity} onChange={(e) => setEntity(e.target.value)} /></Field>
              <Field label="Single sign-on URL" htmlFor="sso-url" hint="Where sign-in requests go (HTTP-Redirect binding)."><input id="sso-url" className="input mono" value={ssoUrl} onChange={(e) => setSsoUrl(e.target.value)} /></Field>
              <Field label="Signing certificate (PEM)" htmlFor="sso-cert" hint="Paste two during a certificate rotation."><textarea id="sso-cert" className="textarea mono" rows={5} value={cert} onChange={(e) => setCert(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" /></Field>
            </>}
          <Check checked={idpInit} onChange={setIdpInit} label="Allow sign-in started from the identity provider" hint="Lets people open RevenueDot from their Okta or Entra dashboard. Each assertion is accepted once; leave off unless you need it." />
        </>}
        {kind === "oidc" && <>
          <Field label="Issuer URL" htmlFor="oidc-issuer" hint="RevenueDot reads /.well-known/openid-configuration from it."><input id="oidc-issuer" className="input mono" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://acme.okta.com" /></Field>
          <Field label="Client ID" htmlFor="oidc-client"><input id="oidc-client" className="input mono" value={clientId} onChange={(e) => setClientId(e.target.value)} /></Field>
          <Field label="Client secret" htmlFor="oidc-secret" hint={conn?.oidc?.has_client_secret ? "Saved. Leave empty to keep it." : "Stored encrypted; never shown again."}><input id="oidc-secret" className="input mono" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>
        </>}
        <Field label={kind === "saml" ? "Groups attribute" : "Groups claim"} htmlFor="sso-groups" hint="Optional. Its values are matched against the group role mappings on the SCIM tab."><input id="sso-groups" className="input mono" value={groupsAttr} onChange={(e) => setGroupsAttr(e.target.value)} placeholder="groups" /></Field>
        <Check checked={jit} onChange={setJit} label="Create accounts at first sign-in" hint="Just-in-time provisioning for addresses on your verified domains. Off: only existing members (for example from SCIM) can sign in." />
        {error && <div className="banner err" role="alert">{error}</div>}
      </div>
    </Dialog>
  );
}

function SpValues({ conn, onClose }: { conn: Connection; onClose: () => void }) {
  return (
    <Dialog title={`Set up ${conn.name} in your identity provider`} onClose={onClose} footer={<button type="button" className="btn btn-dark" onClick={onClose}>Done</button>}>
      <div className="stack">
        {conn.kind === "saml" ? <>
          <p className="section-sub">Create a SAML 2.0 app in your identity provider with these values. Send the user's email address as the NameID (or an <code className="mono">email</code> attribute), and optionally a <code className="mono">groups</code> attribute.</p>
          <Field label="Assertion consumer service (ACS) URL" htmlFor="sp-acs"><CopyField value={conn.sp.acs_url!} label="ACS URL" /></Field>
          <Field label="Entity ID (audience)" htmlFor="sp-entity"><CopyField value={conn.sp.entity_id!} label="entity ID" /></Field>
          <Field label="Service provider metadata" htmlFor="sp-meta"><CopyField value={conn.sp.metadata_url!} label="metadata URL" /></Field>
        </> : <>
          <p className="section-sub">Register a web application in your identity provider with this redirect URI and the scopes <code className="mono">openid email profile</code>.</p>
          <Field label="Redirect URI" htmlFor="sp-redirect"><CopyField value={conn.sp.redirect_uri!} label="redirect URI" /></Field>
        </>}
        <Field label="Test sign-in link" htmlFor="sp-start" hint="Open it in a private window after turning the connection on."><CopyField value={conn.sp.start_url} label="sign-in link" /></Field>
      </div>
    </Dialog>
  );
}

function AddDomain({ org, onClose }: { org: Overview; onClose: () => void }) {
  const qc = useQueryClient();
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true); setError(null);
    try { await api(`${base(org.id)}/sso/domains`, { method: "POST", json: { domain: domain.trim() } }); await qc.invalidateQueries({ queryKey: ["sso-domains", org.id] }); onClose(); }
    catch (e) { setError(errMsg(e)); setBusy(false); }
  };
  return (
    <Dialog title="Add an email domain" onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" disabled={busy || !domain.trim()} onClick={add}>{busy ? "Adding…" : "Add domain"}</button>
    </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <Field label="Domain" htmlFor="sso-domain" hint="The part after @ in your team's work email, e.g. acme.com. You prove you own it with a DNS TXT record."><input id="sso-domain" className="input mono" autoFocus value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.com" /></Field>
        <button type="submit" hidden />
      </form>
      {error && <div className="banner err" role="alert">{error}</div>}
    </Dialog>
  );
}

export function SsoTab({ org }: { org: Overview }) {
  const qc = useQueryClient();
  const toast = useToast();
  const admin = isAdmin(org);
  const conns = useQuery({ queryKey: ["sso-connections", org.id], queryFn: async () => (await api<List<Connection>>(`${base(org.id)}/sso/connections`)).items, enabled: admin });
  const domains = useQuery({ queryKey: ["sso-domains", org.id], queryFn: async () => (await api<List<Domain>>(`${base(org.id)}/sso/domains`)).items, enabled: admin });
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [showing, setShowing] = useState<Connection | null>(null);
  const [addingDomain, setAddingDomain] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; run: () => Promise<unknown> } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["sso-connections", org.id] }), qc.invalidateQueries({ queryKey: ["sso-domains", org.id] }), qc.invalidateQueries({ queryKey: ["org", org.id] })]);
  if (!admin) return <EmptyState title="Owners and admins manage single sign-on" text="Ask an organization admin to change it." />;
  const toggle = async (c: Connection, enabled: boolean) => {
    try { await api(`${base(org.id)}/sso/connections/${c.id}`, { method: "POST", json: { enabled } }); await refresh(); toast(`${c.name} is ${enabled ? "on" : "off"}.`); }
    catch (e) { toast(errMsg(e)); }
  };
  const verify = async (d: Domain) => {
    setChecking(d.domain);
    try {
      const r = await api<Domain>(`${base(org.id)}/sso/domains/${encodeURIComponent(d.domain)}/actions/verify`, { method: "POST" });
      await refresh();
      toast(r.verified ? `${d.domain} is verified.` : r.last_error ?? "The TXT record was not found yet.");
    } catch (e) { toast(errMsg(e)); await refresh(); } finally { setChecking(null); }
  };
  const enforce = async (on: boolean) => {
    try { await api(base(org.id), { method: "POST", json: { sso_enforced: on } }); await refresh(); toast(on ? "Single sign-on is now required." : "Password sign-in is allowed again."); }
    catch (e) { toast(errMsg(e)); }
  };
  const verified = domains.data?.filter((d) => d.verified) ?? [];
  return (
    <div className="stack">
      <section className="panel">
        <div className="ph"><b>Connections</b><button type="button" className="btn btn-dark" onClick={() => setEditing("new")}><Icon name="plus" />New connection</button></div>
        {conns.isError && <div className="pb"><div className="banner err" role="alert">{errMsg(conns.error)}</div></div>}
        {conns.data && !conns.data.length && <div className="pb"><EmptyState title="No connection yet" text="Connect Okta, Microsoft Entra ID, Google Workspace, OneLogin, JumpCloud or any SAML 2.0 or OpenID Connect provider." /></div>}
        {!!conns.data?.length && (
          <div className="tbl members">
            <table>
              <thead><tr><th>Connection</th><th className="hide-sm">Protocol</th><th>On</th><th aria-label="Actions" /></tr></thead>
              <tbody>{conns.data.map((c) => (
                <tr key={c.id}>
                  <td><b>{c.name}</b><div className="subtle">{c.kind === "saml" ? c.saml?.idp_entity_id : c.oidc?.issuer}</div></td>
                  <td className="hide-sm"><Tag>{c.kind === "saml" ? "SAML 2.0" : "OpenID Connect"}</Tag>{c.saml?.allow_idp_initiated && <> <Tag tone="info">IdP-initiated</Tag></>}</td>
                  <td><Switch checked={c.enabled} label={c.enabled ? "On" : "Off"} onChange={(v) => void toggle(c, v)} /></td>
                  <td className="actions-cell"><Menu label={`Actions for ${c.name}`} items={[
                    { label: "Values for your identity provider", icon: "copy", onSelect: () => setShowing(c) },
                    { label: "Edit", icon: "edit", onSelect: () => setEditing(c) },
                    { label: "Test sign-in", icon: "arrow", disabled: !c.enabled, hint: "Turn the connection on first", onSelect: () => window.open(c.sp.start_url, "_blank", "noopener") },
                    "-",
                    { label: "Delete", icon: "trash", danger: true, onSelect: () => setConfirm({ title: `Delete ${c.name}?`, body: "People can no longer sign in through it. Accounts and memberships stay.", label: "Delete connection", run: async () => { await api(`${base(org.id)}/sso/connections/${c.id}`, { method: "DELETE" }); await refresh(); } }) },
                  ]} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="ph"><b>Verified domains</b><button type="button" className="btn btn-line" onClick={() => setAddingDomain(true)}><Icon name="plus" />Add domain</button></div>
        <div className="pb stack">
          <p className="section-sub">Single sign-on only signs in addresses on domains this organization verified, so an identity provider can never sign in as someone else's account.</p>
          {domains.data?.map((d) => (
            <div key={d.domain} className="card">
              <div className="card-h"><b className="mono">{d.domain}</b>{d.verified ? <Tag tone="up">Verified</Tag> : <Tag tone="info">Pending</Tag>}
                <Menu label={`Actions for ${d.domain}`} items={[{ label: "Remove domain", icon: "trash", danger: true, onSelect: () => setConfirm({ title: `Remove ${d.domain}?`, body: "Addresses on it can no longer sign in with single sign-on, and enforcement no longer applies to them.", label: "Remove domain", run: async () => { await api(`${base(org.id)}/sso/domains/${encodeURIComponent(d.domain)}`, { method: "DELETE" }); await refresh(); } }) }]} />
              </div>
              {!d.verified && <>
                <p>Add this TXT record at your DNS provider, then check it. DNS changes can take a few minutes.</p>
                <Field label="Name" htmlFor={`txt-n-${d.domain}`}><CopyField value={d.txt_record.name} label="record name" /></Field>
                <Field label="Value" htmlFor={`txt-v-${d.domain}`}><CopyField value={d.txt_record.value} label="record value" /></Field>
                {d.last_error && <StatusLine tone="bad">{d.last_error}</StatusLine>}
                <div><button type="button" className="btn btn-dark" disabled={checking === d.domain} onClick={() => void verify(d)}>{checking === d.domain ? "Checking…" : "Check DNS"}</button></div>
              </>}
              {d.verified && d.verified_at && <p>Verified {fmt.date(d.verified_at)}.</p>}
            </div>
          ))}
          {domains.data && !domains.data.length && <p className="section-sub subtle">No domains yet.</p>}
        </div>
      </section>

      <section className="panel">
        <div className="ph"><b>Require single sign-on</b><Switch checked={org.sso_enforced} label={org.sso_enforced ? "Required" : "Optional"} onChange={(v) => v ? setConfirm({ title: "Require single sign-on?", body: `Everyone with an address on ${verified.map((d) => d.domain).join(", ") || "your verified domains"} must sign in through your identity provider. Their passwords stop working and password sessions lose access to this organization's projects. Owners keep password sign-in for emergencies.`, label: "Require single sign-on", run: () => enforce(true) }) : void enforce(false)} /></div>
        <div className="pb stack">
          <p className="section-sub">{org.sso_enforced ? "Required for addresses on your verified domains. Owners can still use a password if your identity provider is down." : "Members can use a password or single sign-on. Turn this on once a connection works and a domain is verified."}</p>
          <p className="section-sub">People on other domains, such as contractors, keep signing in with a password.</p>
        </div>
      </section>

      {editing && <ConnectionDialog org={org} conn={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {showing && <SpValues conn={showing} onClose={() => setShowing(null)} />}
      {addingDomain && <AddDomain org={org} onClose={() => setAddingDomain(false)} />}
      {confirm && <ConfirmDialog title={confirm.title} confirmLabel={confirm.label} danger onConfirm={confirm.run} onClose={() => setConfirm(null)}>{confirm.body}</ConfirmDialog>}
    </div>
  );
}
