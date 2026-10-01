import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Icon } from "../../components/icons";
import { ConfirmDialog, Dialog, EmptyState, Field, Menu, Segmented, Switch, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { base, errMsg } from "../setup/data";
import { cssColor, fontStyleName, gradientCss, keyOf, saveBrand, uploadFont, useBrand, useFonts, type ColorPreset, type Font, type GradientPoint, type GradientPreset } from "./lib";
import "./settings.css";

/**
 * Brand tab (prd/project-settings §2): colour presets, gradient presets and uploaded fonts. The paywall editor shows them
 * in its colour and font pickers, and the SDKs receive the presets as named colours (`ui_config.app.colors`).
 */

const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const six = (h: string) => (h.length >= 7 ? h.slice(0, 7) : "#000000");
/** A colour picked in the native picker (which has no alpha) keeps the alpha the hex had. */
const withAlpha = (picked: string, prev: string) => `${picked.toUpperCase()}${HEX.test(prev) && prev.length === 9 ? prev.slice(7).toUpperCase() : ""}`;

function ColorDialog({ initial, taken, onSave, onClose }: { initial: ColorPreset | null; taken: string[]; onSave: (c: ColorPreset) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [light, setLight] = useState(initial ? initial.light.toUpperCase() : "#0A0A0A");
  const [darkOn, setDarkOn] = useState(!!initial?.dark);
  const [dark, setDark] = useState(initial?.dark ? initial.dark.toUpperCase() : "#FAFAFA");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = initial?.key ?? keyOf(name, taken);
  const save = async () => {
    if (!name.trim()) return setError("Give the colour a name.");
    if (!HEX.test(light) || (darkOn && !HEX.test(dark))) return setError("Colours are #RRGGBB or #RRGGBBAA.");
    if (!initial && taken.includes(key)) return setError(`A preset named like this exists (${key}). Pick another name.`);
    setBusy(true);
    try { await onSave({ key, name: name.trim(), light, dark: darkOn ? dark : null }); onClose(); } catch (e) { setError(errMsg(e)); setBusy(false); }
  };
  const swatch = (id: string, v: string, set: (s: string) => void, label: string) => (
    <div className="br-hex">
      <input type="color" aria-label={`${label} picker`} value={six(HEX.test(v) ? v : "#000000")} onChange={(e) => set(withAlpha(e.target.value, v))} />
      <input id={id} className="input mono" value={v} maxLength={9} onChange={(e) => set(e.target.value.trim())} />
    </div>
  );
  return (
    <Dialog title={initial ? `Edit ${initial.name}` : "Add colour preset"} onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save colour"}</button>
    </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Name" htmlFor="br-name" hint={<>Paywalls can refer to it as <code>{key}</code>.</>}>
          <input id="br-name" className="input" autoFocus maxLength={60} value={name} onChange={(e) => { setName(e.target.value); setError(null); }} />
        </Field>
        <Field label="Light mode" htmlFor="br-light">{swatch("br-light", light, setLight, "Light mode colour")}</Field>
        <Switch checked={darkOn} onChange={setDarkOn} label="Different colour in dark mode" />
        {darkOn && <Field label="Dark mode" htmlFor="br-dark">{swatch("br-dark", dark, setDark, "Dark mode colour")}</Field>}
        {error && <div className="banner err" role="alert">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function GradientDialog({ initial, taken, onSave, onClose }: { initial: GradientPreset | null; taken: string[]; onSave: (g: GradientPreset) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<"linear" | "radial">(initial?.type ?? "linear");
  const [degrees, setDegrees] = useState(initial?.degrees ?? 180);
  const [points, setPoints] = useState<GradientPoint[]>(initial?.points.map((p) => ({ color: p.color.toUpperCase(), percent: p.percent })) ?? [{ color: "#0A0A0A", percent: 0 }, { color: "#525252", percent: 100 }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = initial?.key ?? keyOf(name, taken);
  const setPoint = (i: number, p: Partial<GradientPoint>) => setPoints((ps) => ps.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const save = async () => {
    if (!name.trim()) return setError("Give the gradient a name.");
    if (points.some((p) => !HEX.test(p.color))) return setError("Every stop needs a #RRGGBB or #RRGGBBAA colour.");
    if (!initial && taken.includes(key)) return setError(`A preset named like this exists (${key}). Pick another name.`);
    setBusy(true);
    try { await onSave({ key, name: name.trim(), type, ...(type === "linear" ? { degrees } : {}), points: [...points].sort((a, b) => a.percent - b.percent), dark_points: initial?.dark_points ?? null }); onClose(); }
    catch (e) { setError(errMsg(e)); setBusy(false); }
  };
  return (
    <Dialog title={initial ? `Edit ${initial.name}` : "Add gradient preset"} onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save gradient"}</button>
    </>}>
      <div className="stack">
        <div className="br-preview" style={{ background: gradientCss({ type, degrees, points }) }} aria-hidden="true" />
        <Field label="Name" htmlFor="gr-name" hint={<>Paywalls can refer to it as <code>{key}</code>.</>}>
          <input id="gr-name" className="input" autoFocus maxLength={60} value={name} onChange={(e) => { setName(e.target.value); setError(null); }} />
        </Field>
        <div className="hrow">
          <Segmented label="Gradient type" value={type} onChange={setType} options={[{ value: "linear", label: "Linear" }, { value: "radial", label: "Radial" }]} />
          {type === "linear" && <label className="hrow subtle">Angle <input aria-label="Angle in degrees" className="input mono br-num" type="number" min={0} max={360} value={degrees} onChange={(e) => setDegrees(Math.max(0, Math.min(360, Math.round(Number(e.target.value) || 0))))} />°</label>}
        </div>
        <fieldset className="br-stops">
          <legend className="flabel">Stops</legend>
          {points.map((p, i) => (
            <div key={i} className="hrow">
              <input type="color" aria-label={`Stop ${i + 1} colour`} value={six(HEX.test(p.color) ? p.color : "#000000")} onChange={(e) => setPoint(i, { color: withAlpha(e.target.value, p.color) })} />
              <input aria-label={`Stop ${i + 1} hex`} className="input mono br-hexin" value={p.color} maxLength={9} onChange={(e) => setPoint(i, { color: e.target.value.trim() })} />
              <input aria-label={`Stop ${i + 1} position`} className="input mono br-num" type="number" min={0} max={100} value={p.percent} onChange={(e) => setPoint(i, { percent: Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))) })} /><span className="subtle">%</span>
              <button type="button" className="ib" aria-label={`Remove stop ${i + 1}`} disabled={points.length <= 2} onClick={() => setPoints((ps) => ps.filter((_, j) => j !== i))}><Icon name="close" /></button>
            </div>
          ))}
          {points.length < 10 && <button type="button" className="linkbtn" onClick={() => setPoints((ps) => [...ps, { color: "#FFFFFF", percent: 100 }])}>+ Add stop</button>}
        </fieldset>
        {error && <div className="banner err" role="alert">{error}</div>}
      </div>
    </Dialog>
  );
}

export function BrandTab({ pid }: { pid: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const brand = useBrand(pid);
  const fonts = useFonts(pid);
  const [editColor, setEditColor] = useState<ColorPreset | null | "new">(null);
  const [editGradient, setEditGradient] = useState<GradientPreset | null | "new">(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; run: () => Promise<unknown> } | null>(null);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const colors = brand.data?.color_presets ?? [], gradients = brand.data?.gradient_presets ?? [];
  const taken = [...colors, ...gradients].map((x) => x.key);
  const save = async (b: Parameters<typeof saveBrand>[1], msg: string) => {
    const r = await saveBrand(pid, b);
    qc.setQueryData(["brand", pid], r);
    toast(msg);
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setUploading(true);
    try { const font = await uploadFont(pid, f); await qc.invalidateQueries({ queryKey: ["fonts", pid] }); toast(`${font.family_name} ${fontStyleName(font)} uploaded.`); }
    catch (e) { toast(errMsg(e)); } finally { setUploading(false); if (file.current) file.current.value = ""; }
  };
  const families = new Map<string, Font[]>();
  for (const f of fonts.data ?? []) families.set(f.family_name, [...(families.get(f.family_name) ?? []), f]);

  if (brand.isError) return <div className="banner err" role="alert">The brand settings could not be loaded: {errMsg(brand.error)}</div>;
  return (
    <div className="stack">
      <section className="panel">
        <div className="ph"><b>Colour presets</b><button type="button" className="btn btn-line" onClick={() => setEditColor("new")}><Icon name="plus" />Add colour</button></div>
        <div className="pb stack">
          <p className="section-sub">Your app's colours, one click away in every colour picker of the paywall editor. Apps receive them as named colours too.</p>
          {brand.isLoading ? <div className="subtle">Loading…</div> : !colors.length ? <p className="subtle">No colour presets yet.</p> : (
            <ul className="br-grid" aria-label="Colour presets">
              {colors.map((c) => (
                <li key={c.key} className="br-item">
                  <span className="br-sw" aria-hidden="true"><span style={{ background: cssColor(c.light) }} />{c.dark && <span style={{ background: cssColor(c.dark) }} />}</span>
                  <span className="br-meta"><b>{c.name}</b><code>{c.light.slice(0, 7).toUpperCase()}{c.dark ? ` / ${c.dark.slice(0, 7).toUpperCase()}` : ""}</code></span>
                  <Menu label={`Actions for ${c.name}`} items={[
                    { label: "Edit", icon: "edit", onSelect: () => setEditColor(c) },
                    { label: "Delete", icon: "trash", danger: true, onSelect: () => setConfirm({ title: `Delete ${c.name}?`, body: "Paywalls keep the colour they already use. Paywalls that refer to it by name fall back to the app's default colour.", run: () => save({ color_presets: colors.filter((x) => x.key !== c.key) }, `${c.name} deleted.`) }) },
                  ]} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="ph"><b>Gradient presets</b><button type="button" className="btn btn-line" onClick={() => setEditGradient("new")}><Icon name="plus" />Add gradient</button></div>
        <div className="pb stack">
          {brand.isLoading ? <div className="subtle">Loading…</div> : !gradients.length ? <p className="subtle">No gradient presets yet. They show up in background pickers.</p> : (
            <ul className="br-grid" aria-label="Gradient presets">
              {gradients.map((g) => (
                <li key={g.key} className="br-item">
                  <span className="br-sw br-gr" aria-hidden="true" style={{ background: gradientCss(g) }} />
                  <span className="br-meta"><b>{g.name}</b><code>{g.type === "linear" ? `Linear ${g.degrees ?? 180}°` : "Radial"} · {g.points.length} stops</code></span>
                  <Menu label={`Actions for ${g.name}`} items={[
                    { label: "Edit", icon: "edit", onSelect: () => setEditGradient(g) },
                    { label: "Delete", icon: "trash", danger: true, onSelect: () => setConfirm({ title: `Delete ${g.name}?`, body: "Paywalls keep the gradient they already use.", run: () => save({ gradient_presets: gradients.filter((x) => x.key !== g.key) }, `${g.name} deleted.`) }) },
                  ]} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="ph"><b>Fonts</b>
          <button type="button" className="btn btn-line" disabled={uploading} onClick={() => file.current?.click()}><Icon name="plus" />{uploading ? "Uploading…" : "Upload font"}</button>
          <input ref={file} type="file" accept=".ttf,.otf,font/ttf,font/otf" hidden aria-label="Font file" onChange={(e) => void upload(e.target.files?.[0])} />
        </div>
        {fonts.isLoading ? <div className="pb subtle">Loading…</div> : !families.size ? (
          <div className="pb"><EmptyState title="No custom fonts" text="Upload TrueType or OpenType files up to 5 MB. Each weight and style is its own file. The paywall editor's font picker lists them, and apps download them with the paywall." /></div>
        ) : (
          <div className="tbl">
            <table>
              <thead><tr><th>Family</th><th>Style</th><th className="hide-sm">Font name</th><th aria-label="Actions" /></tr></thead>
              <tbody>{[...families].flatMap(([family, list]) => list.sort((a, b) => a.weight - b.weight).map((f, i) => (
                <tr key={f.id}>
                  <td>{i === 0 ? <b>{family}</b> : <span className="subtle">{family}</span>}</td>
                  <td>{fontStyleName(f)} <span className="subtle mono">{f.weight}</span></td>
                  <td className="hide-sm"><code>{f.name}</code></td>
                  <td className="actions-cell"><Menu label={`Actions for ${f.name}`} items={[{ label: "Delete font", icon: "trash", danger: true, onSelect: () => setConfirm({
                    title: `Delete ${f.name}?`, body: "Paywalls that use this font show the system font instead.",
                    run: async () => { await api(`${base(pid)}/fonts/${f.id}`, { method: "DELETE" }); await qc.invalidateQueries({ queryKey: ["fonts", pid] }); toast(`${f.name} deleted.`); },
                  }) }]} /></td>
                </tr>
              )))}</tbody>
            </table>
          </div>
        )}
      </section>

      {editColor && <ColorDialog initial={editColor === "new" ? null : editColor} taken={taken} onClose={() => setEditColor(null)}
        onSave={(c) => save({ color_presets: editColor === "new" ? [...colors, c] : colors.map((x) => (x.key === c.key ? c : x)) }, `${c.name} saved.`)} />}
      {editGradient && <GradientDialog initial={editGradient === "new" ? null : editGradient} taken={taken} onClose={() => setEditGradient(null)}
        onSave={(g) => save({ gradient_presets: editGradient === "new" ? [...gradients, g] : gradients.map((x) => (x.key === g.key ? g : x)) }, `${g.name} saved.`)} />}
      {confirm && <ConfirmDialog title={confirm.title} confirmLabel="Delete" danger onConfirm={confirm.run} onClose={() => setConfirm(null)}>{confirm.body}</ConfirmDialog>}
    </div>
  );
}
