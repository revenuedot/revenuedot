// RevenueDot Enterprise (ee/LICENSE). Organization settings, Data location tab.
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../apps/dashboard/src/lib/api";
import { Field, useToast } from "../../../apps/dashboard/src/components/ui";
import { base, errMsg, isAdmin, useOrgProjects, type Overview } from "../lib";

const NAMES: Record<string, string> = { us: "United States", eu: "European Union" };

export function DataLocationTab({ org }: { org: Overview }) {
  const qc = useQueryClient();
  const toast = useToast();
  const projects = useOrgProjects(org.id);
  const admin = isAdmin(org);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["org", org.id] }), qc.invalidateQueries({ queryKey: ["org-projects", org.id] })]);
  const setDefault = async (region: string) => {
    try { await api(base(org.id), { method: "POST", json: { region } }); await refresh(); toast(`New projects default to ${NAMES[region]}.`); }
    catch (e) { toast(errMsg(e)); }
  };
  const setProject = async (pid: string, name: string, region: string) => {
    try { await api(`${base(org.id)}/projects/${pid}/region`, { method: "POST", json: { region } }); await refresh(); toast(`${name} is now stored in ${NAMES[region]}.`); }
    catch (e) { toast(errMsg(e)); await refresh(); }
  };
  const options = (current: string) => [...new Set([current, ...org.selectable_regions])];
  return (
    <div className="stack">
      <section className="panel">
        <div className="ph"><b>Where data is stored</b></div>
        <div className="pb stack">
          {org.region_enforced
            ? <p className="section-sub">Each region is a separate RevenueDot deployment with its own database. A project's customers, purchases and events are stored and processed only in its region; requests that reach another region are refused. Point an app's SDK at the region's API address.</p>
            : <p className="section-sub">This server runs where you host it, so every project's data is stored there. The region is recorded for your records and for moving to RevenueDot Cloud later; nothing is moved.</p>}
          <Field label="Default for new projects" htmlFor="org-region">
            <select id="org-region" className="select" value={org.region} disabled={!admin} onChange={(e) => void setDefault(e.target.value)}>
              {options(org.region).map((r) => <option key={r} value={r} disabled={!org.selectable_regions.includes(r)}>{NAMES[r] ?? r}</option>)}
            </select>
          </Field>
        </div>
      </section>
      <section className="panel">
        <div className="ph"><b>Projects</b></div>
        {projects.data && (
          <div className="tbl members">
            <table>
              <thead><tr><th>Project</th><th>Region</th></tr></thead>
              <tbody>{projects.data.map((p) => (
                <tr key={p.id}>
                  <td><b>{p.name}</b><div className="subtle mono">{p.id}</div></td>
                  <td>{admin
                    ? <select className="select" aria-label={`Region of ${p.name}`} value={p.region} onChange={(e) => void setProject(p.id, p.name, e.target.value)}>{options(p.region).map((r) => <option key={r} value={r} disabled={!org.selectable_regions.includes(r)}>{NAMES[r] ?? r}</option>)}</select>
                    : NAMES[p.region] ?? p.region}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {org.region_enforced && <div className="pb"><p className="section-sub">A project stays in the region where it was created. To keep a new project in another region, create it on that region's dashboard; to move an existing one, email support@revenuedot.app, who move it with a plan so no purchase is lost.</p></div>}
      </section>
    </div>
  );
}
