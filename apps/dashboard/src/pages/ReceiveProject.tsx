import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useMe } from "../components/Shell";
import { Mark } from "../components/icons";
import { CodeBlock, CopyButton, Tag } from "../components/ui";
import "./billing.css";

/**
 * Receive a project (/projects/receive, prd/moves-export/PRD.md §6): an import token for moving a project to this server
 * from another RevenueDot (self-host to Cloud, Cloud to self-host), the command to run, and the imports in progress.
 */

interface Imp { id: string; status: "open" | "importing" | "finished" | "cancelled"; project_id: string | null; source_url: string | null; files_done: Record<string, string>; files_total: number; created_at: number; expires_at: number }

export function ReceiveProject() {
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [token, setToken] = useState<{ token: string; url: string; expires_at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { document.title = "Receive a project · RevenueDot"; }, []);
  useEffect(() => { if (me.isError) nav(`/login?next=${encodeURIComponent("/projects/receive")}`, { replace: true }); }, [me.isError, nav]);
  const imports = useQuery({ queryKey: ["imports"], queryFn: () => api<{ items: Imp[] }>("/v2/imports"), refetchInterval: 3000, enabled: !!me.data });
  const create = async () => {
    setBusy(true); setError(null);
    try { setToken(await api("/v2/imports/tokens", { method: "POST" })); await qc.invalidateQueries({ queryKey: ["imports"] }); }
    catch (e) { setError(e instanceof Error ? e.message : "The token could not be created."); } finally { setBusy(false); }
  };
  const here = token?.url ?? (me.data?.account?.edition === "cloud" ? "https://api.revenuedot.app" : window.location.origin);
  const back = me.data?.projects[0] ? `/projects/${me.data.projects[0].id}/overview` : "/projects/new";
  const live = (imports.data?.items ?? []).filter((i) => i.status !== "open");
  return (
    <main className="auth">
      <section className="auth-card wide" aria-label="Receive a project">
        <Mark size={36} />
        <div>
          <h1>Receive a project</h1>
          <p>Move a project here from another RevenueDot server, with its customers, purchases, SDK keys and webhooks. Create an import token, then start the move on the old server (Project settings → Export and move) or with the command line.</p>
        </div>
        {!token ? (
          <button type="button" className="btn btn-dark btn-lg" disabled={busy || !me.data} onClick={create}>{busy ? "Creating…" : "Create import token"}</button>
        ) : (
          <div className="stack">
            <div className="banner ok" role="status">Copy the token now: it is shown once and works for 24 hours.</div>
            <div className="field">
              <span className="flabel">Import token</span>
              <div className="hrow"><code className="mono token-box" data-token>{token.token}</code><CopyButton value={token.token} /></div>
              <span className="hint">Anyone with this token can move a project into your account here. Keep it private.</span>
            </div>
            <CodeBlock label="From a terminal" code={`npx revenuedot move --from <old server URL> --to ${here} --dry-run\nnpx revenuedot move --from <old server URL> --to ${here}\nnpx revenuedot move --from <old server URL> --to ${here} --finish`} />
            <p className="hint">The CLI asks for the old project's secret API key and this token, and hides what you type.</p>
          </div>
        )}
        {error && <div className="banner err" role="alert">{error}</div>}
        {live.length > 0 && (
          <div className="stack" aria-label="Moves into this server">
            <b>Moves into this server</b>
            {live.map((i) => (
              <div key={i.id} className="hrow" data-import={i.id}>
                <span className="mono">{i.project_id ?? "…"}</span>
                {i.status === "finished" ? <Tag tone="up">Live</Tag> : i.status === "importing" ? <Tag tone="info">{i.files_total && Object.keys(i.files_done).length >= i.files_total ? "Copied, not live yet" : `Copying ${Object.keys(i.files_done).length}/${i.files_total}`}</Tag> : <Tag>{i.status}</Tag>}
                {i.source_url && <span className="subtle">from {i.source_url}</span>}
                {i.project_id && (i.status === "finished" || i.status === "importing") && <Link to={`/projects/${i.project_id}/overview`} onClick={() => qc.invalidateQueries({ queryKey: ["me"] })}>Open</Link>}
              </div>
            ))}
          </div>
        )}
        <p><Link to={back} className="link-u">Back to the dashboard</Link></p>
      </section>
    </main>
  );
}
