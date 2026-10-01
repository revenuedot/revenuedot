import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Shell } from "../../components/Shell";
import { CopyField, KeyValue, PageHead, Panel, StatusLine, useProjectId, useToast } from "../../components/ui";
import { api, fmt } from "../../lib/api";
import { apiOrigin, base, errMsg, useIntegrations } from "./data";

/**
 * The help desk apps (prd/integrations/PRD.md, "Support apps"):
 * - Intercom inbox: the event form (the app's client secret) plus this panel with the Canvas Kit URL to register.
 * - Zendesk (/projects/:projectId/integrations/zendesk): the private sidebar app in `integrations/zendesk-app/` with
 *   its three settings; "Mark as installed" makes the card show as active.
 */

const GUIDE = "https://revenuedot.app/docs/guides/support-integrations";
const APP_SOURCE = "https://github.com/revenuedot/revenuedot/tree/main/integrations/zendesk-app";

export function IntercomInboxPanel({ pid }: { pid: string }) {
  return (
    <Panel title="Set up the Intercom inbox app" link={<a href={`${GUIDE}#intercom`} target="_blank" rel="noreferrer">Guide →</a>}>
      <div className="stack">
        <ol className="steps">
          <li>In the Intercom Developer Hub, create an app and open <b>Canvas Kit</b>. For the <b>Inbox</b>, set the initialize URL to the address below.</li>
          <li>Copy the app's <b>client secret</b> from Basic information into the field on this page and save. RevenueDot checks every request's signature with it.</li>
          <li>Install the app in your workspace and add it to the inbox sidebar. Contacts are matched by their user ID (your app user ID), then by email.</li>
        </ol>
        <CopyField value={`${apiOrigin()}/v1/support/intercom/${pid}/canvas`} label="Canvas Kit initialize URL" />
      </div>
    </Panel>
  );
}

export function ZendeskPage() {
  const pid = useProjectId();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useIntegrations(pid);
  const current = list.data?.find((i) => i.type === "zendesk");
  const [busy, setBusy] = useState(false);
  const mark = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) await api(`${base(pid)}/integrations/partners`, { method: "POST", json: { type: "zendesk", settings: {} } });
      else if (current) await api(`${base(pid)}/integrations/partners/${current.id}`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["integrations", pid] });
      toast(on ? "Zendesk is marked as installed." : "Zendesk is no longer marked as installed.");
    } catch (e) { toast(errMsg(e)); } finally { setBusy(false); }
  };
  const crumbs = <><Link to={`/projects/${pid}/integrations`}>Integrations</Link> <span>/</span> <b>Zendesk</b></>;
  return (
    <Shell title="Zendesk" crumbs={crumbs}>
      <div className="page narrow">
        <PageHead title="Zendesk" sub="A ticket sidebar app with the requester's subscription status, entitlements, total spent, refunds and open Customer Center tickets."
          actions={current ? <button type="button" className="btn btn-line" disabled={busy} onClick={() => mark(false)}>Mark as not installed</button> : <button type="button" className="btn btn-dark" disabled={busy} onClick={() => mark(true)}>Mark as installed</button>} />
        <KeyValue rows={[
          ["Status", current ? <StatusLine tone="ok">Installed {fmt.ago(current.created_at)}</StatusLine> : <StatusLine tone="idle">Not installed yet</StatusLine>],
          ["Project ID", <span className="mono">{pid}</span>],
          ["API URL", <span className="mono">{apiOrigin()}</span>],
        ]} />
        <Panel title="Install the sidebar app" link={<a href={`${GUIDE}#zendesk`} target="_blank" rel="noreferrer">Guide →</a>}>
          <div className="stack">
            <ol className="steps">
              <li><Link className="link-u" to={`/projects/${pid}/api-keys`}>Create a secret API key</Link> with only the <b>customer_information:customers:read</b> permission.</li>
              <li>Download the app from <a className="link-u" href={APP_SOURCE} target="_blank" rel="noreferrer">integrations/zendesk-app</a> and upload it as a private app in Zendesk (Admin Center › Apps and integrations › Zendesk Support apps › Upload private app), or run <code>zcli apps:create</code>.</li>
              <li>Enter the API URL, the project ID and the secret key in the app's settings. Zendesk keeps the key as a secure setting, so agents' browsers never see it. A self-hosted server must also be added to <code>domainWhitelist</code> in <code>manifest.json</code>.</li>
            </ol>
            <CopyField value={pid} label="project ID" />
          </div>
        </Panel>
      </div>
    </Shell>
  );
}
