import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMe, type Me } from "../../components/Shell";
import { Switch, Tag, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { WEEKDAYS } from "../../lib/prefs";
import { AccountLayout, Row, Section, errText } from "./AccountLayout";

/**
 * Notifications (RevenueCat: Settings → Notifications): the alert emails of 1.18, and per project the weekly summary,
 * experiment results and revenue anomaly alerts with a sensitivity. Everything per person; any member may subscribe.
 */
interface ProjectPrefs { project: { id: string; name: string; role: string }; weekly_summary: boolean; experiment_results: boolean; anomaly_alerts: boolean; anomaly_sensitivity: "low" | "medium" | "high" }
interface Settings { alert_emails: boolean; integration_alert_emails?: boolean; projects: ProjectPrefs[] }
type Key = "weekly_summary" | "experiment_results" | "anomaly_alerts";

export function AccountNotificationsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["notifications"], queryFn: () => api<Settings>("/auth/notifications") });
  const saveAlerts = async (v: boolean) => {
    try {
      const r = await api<{ user: Me["user"] }>("/auth/me", { method: "POST", json: { alert_emails: v } });
      qc.setQueryData<Me>(["me"], (m) => (m ? { ...m, user: { ...m.user, ...r.user } } : m));
      qc.setQueryData<Settings>(["notifications"], (s) => (s ? { ...s, alert_emails: v } : s));
      toast(v ? "Alert emails are on." : "Alert emails are off.");
    } catch (e) { toast(errText(e)); }
  };
  const saveIntegrations = async (v: boolean) => {
    try {
      const r = await api<{ user: Me["user"] }>("/auth/me", { method: "POST", json: { integration_alert_emails: v } });
      qc.setQueryData<Me>(["me"], (m) => (m ? { ...m, user: { ...m.user, ...r.user } } : m));
      qc.setQueryData<Settings>(["notifications"], (s) => (s ? { ...s, integration_alert_emails: v } : s));
      toast(v ? "Integration failure emails are on." : "Integration failure emails are off.");
    } catch (e) { toast(errText(e)); }
  };
  const saveProduct = async (v: boolean) => {
    try {
      const r = await api<{ user: Me["user"] }>("/auth/me", { method: "POST", json: { product_emails: v } });
      qc.setQueryData<Me>(["me"], (m) => (m ? { ...m, user: { ...m.user, ...r.user } } : m));
      toast(v ? "Setup help and tips are on." : "Setup help and tips are off.");
    } catch (e) { toast(errText(e)); }
  };
  const saveDigest = async (v: boolean) => {
    try {
      const r = await api<{ user: Me["user"] }>("/auth/me", { method: "POST", json: { insights_emails: v } });
      qc.setQueryData<Me>(["me"], (m) => (m ? { ...m, user: { ...m.user, ...r.user } } : m));
      toast(v ? "The weekly digest is on." : "The weekly digest is off.");
    } catch (e) { toast(errText(e)); }
  };
  const save = async (p: ProjectPrefs, patch: Partial<Pick<ProjectPrefs, Key | "anomaly_sensitivity">>, done: string) => {
    qc.setQueryData<Settings>(["notifications"], (s) => (s ? { ...s, projects: s.projects.map((x) => (x.project.id === p.project.id ? { ...x, ...patch } : x)) } : s));
    try { await api(`/auth/notifications/${p.project.id}`, { method: "PUT", json: patch }); toast(done); }
    catch (e) { toast(errText(e)); void qc.invalidateQueries({ queryKey: ["notifications"] }); }
  };
  const week = WEEKDAYS[me.data?.user.preferences?.week_start ?? 1];
  return (
    <AccountLayout section="notifications">
      {me.data && <>
        <Section title="Problems with your projects" id="alerts">
          <Row label="Alert emails" help="For projects where you are an admin: store notifications failing, a webhook or an integration that keeps failing, or store credentials that Apple or Google rejected. At most one email a day per problem, and one when it is fixed.">
            <Switch checked={me.data.user.alert_emails} onChange={saveAlerts} label="Email me about problems with my projects" />
          </Row>
          <Row label="Integration failures" help={me.data.user.alert_emails
            ? "When an integration (Amplitude, Segment, Slack …) failed its last 10 deliveries, or more than half of its delivery attempts in the last hour, with a link to its delivery log."
            : "Turn on alert emails above to get these."}>
            <Switch checked={me.data.user.integration_alert_emails ?? true} disabled={!me.data.user.alert_emails} onChange={saveIntegrations} label="Email me when an integration keeps failing" />
          </Row>
          {me.data.account?.features?.insights_digest && (
            <Row label="Weekly growth insights" help="Every Monday, for projects where you are an admin: 3 to 5 things to act on, written by RevenueDot AI from your own charts, with the numbers behind them.">
              <Switch checked={me.data.user.insights_emails ?? true} onChange={saveDigest} label="Email me the weekly growth insights digest" />
            </Row>
          )}
        </Section>
        {me.data.account?.edition === "cloud" && (
          <Section title="Setup help and tips" id="product">
            <Row label="Setup help, tips and product news" help="Short emails from RevenueDot while you set up: one step and a short video or screenshot each, and they stop once a step is done. Security, billing and alert emails are separate.">
              <Switch checked={me.data.user.product_emails ?? true} onChange={saveProduct} label="Email me setup help, tips and product news" />
            </Row>
          </Section>
        )}
        <Section title="Performance emails" id="performance" sub={<>Per project. The weekly summary arrives each {week} (your first day of the week, in Date and region) with MRR, revenue, new customers, trials and churn against the week before. Revenue anomaly alerts compare yesterday with the 28 days before it, every morning (UTC).</>}>
          {q.isError ? <div className="acct-pad"><div className="banner err" role="alert">{errText(q.error)}</div></div> : !q.data ? <div className="acct-empty">Loading…</div> : !q.data.projects.length ? (
            <div className="acct-empty">You are not in any project yet.</div>
          ) : (
            <div className="tbl"><table className="nmx">
              <thead><tr><th>Project</th><th>Weekly summary</th><th>Experiment results</th><th>Revenue anomalies <Tag tone="info">Beta</Tag></th></tr></thead>
              <tbody>{q.data.projects.map((p) => (
                <tr key={p.project.id} data-project={p.project.id}>
                  <td className="p"><b>{p.project.name}</b></td>
                  <td data-label="Weekly summary"><Switch checked={p.weekly_summary} onChange={(v) => save(p, { weekly_summary: v }, v ? `Weekly summary on for ${p.project.name}.` : `Weekly summary off for ${p.project.name}.`)} label={`Weekly summary for ${p.project.name}`} hideLabel /></td>
                  <td data-label="Experiment results"><Switch checked={p.experiment_results} onChange={(v) => save(p, { experiment_results: v }, v ? `Experiment results on for ${p.project.name}.` : `Experiment results off for ${p.project.name}.`)} label={`Experiment results for ${p.project.name}`} hideLabel /></td>
                  <td data-label="Revenue anomalies (beta)">
                    <div className="nmx-cell">
                      <Switch checked={p.anomaly_alerts} onChange={(v) => save(p, { anomaly_alerts: v }, v ? `Anomaly alerts on for ${p.project.name}.` : `Anomaly alerts off for ${p.project.name}.`)} label={`Revenue anomalies for ${p.project.name}`} hideLabel />
                      {p.anomaly_alerts && (
                        <select className="select sens" aria-label={`Sensitivity for ${p.project.name}`} value={p.anomaly_sensitivity} onChange={(e) => save(p, { anomaly_sensitivity: e.target.value as ProjectPrefs["anomaly_sensitivity"] }, `Sensitivity ${e.target.value} for ${p.project.name}.`)}>
                          <option value="low">Low: big moves only</option><option value="medium">Medium</option><option value="high">High: smaller moves too</option>
                        </select>
                      )}
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          <p className="acct-sub" style={{ paddingBottom: 14 }}>Experiment results: one email when both variants have 100 customers, and one when the experiment is stopped. Password resets, invites and security notices always arrive.</p>
        </Section>
      </>}
    </AccountLayout>
  );
}
