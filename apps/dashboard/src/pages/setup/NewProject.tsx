import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { useMe } from "../../components/Shell";
import { Mark } from "../../components/icons";
import { Field } from "../../components/ui";

/**
 * New project (/projects/new), reached from the project switcher or right after sign-up without a project.
 * GAPS vs RevenueCat: none. RevenueCat asks only for a name too; its project icon upload is not offered.
 */
export function NewProject() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { document.title = "New project · RevenueDot"; }, []);
  useEffect(() => { if (me.isError) nav("/login"); }, [me.isError, nav]);
  const back = me.data?.projects[0] ? `/projects/${me.data.projects[0].id}/overview` : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setError("Give the project a name."); return; }
    if (n.length > 100) { setError("Use 100 characters or fewer."); return; }
    setBusy(true); setError(null);
    try {
      const p = await api<{ id: string }>("/v2/projects", { method: "POST", json: { name: n } });
      await qc.invalidateQueries({ queryKey: ["me"] });
      nav(`/projects/${p.id}/overview`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The project could not be created. Try again.");
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit} noValidate>
        <Mark size={36} />
        <div>
          <h1>Create a project</h1>
          <p>A project holds your apps, products, customers and settings. Put the iOS, Android and web versions of one app in the same project so customers keep their purchases across them.</p>
        </div>
        <Field label="Project name" htmlFor="project-name" hint="You can change it later in Project settings." error={error}>
          <input id="project-name" className="input" autoFocus maxLength={100} placeholder="e.g. Scanner" value={name} aria-invalid={!!error}
            onChange={(e) => { setName(e.target.value); if (error) setError(null); }} />
        </Field>
        <button className="btn btn-dark btn-lg" type="submit" disabled={busy}>{busy ? "Creating…" : "Create project"}</button>
        {back && <p><Link to={back} className="link-u">Cancel</Link></p>}
      </form>
    </main>
  );
}
