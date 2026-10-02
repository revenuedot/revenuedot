// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the two ends of `npx revenuedot move` over HTTP: the source server (REST API v2 with a secret key) and the
// target server (the import API with an `rdi_` import token), plus a downloaded archive as a source. No Node APIs.
// Docs: https://revenuedot.app/docs/guides/move-projects
import { HttpError, requestJson, type HttpOptions } from "../http.js";
import type { ExportInfo, FinishReport, Manifest, MoveSource, MoveTarget, Plan, VerifyResult } from "./core.js";

const trim = (u: string) => u.replace(/\/+$/, "");

/** GET or PUT raw bytes, retrying server errors and network failures like requestJson. */
export async function requestBytes(url: string, init: RequestInit, o: HttpOptions = {}): Promise<Uint8Array> {
  const f = o.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    let err: unknown = null;
    try { res = await f(url, { ...init, signal: AbortSignal.timeout(o.timeoutMs ?? 120_000) }); } catch (e) { err = e; }
    if (res?.ok) return new Uint8Array(await res.arrayBuffer());
    const retry = !res || res.status >= 500 || res.status === 429;
    if (!retry || attempt >= (o.maxRetries ?? 5)) {
      if (!res) throw new Error(`Could not reach ${url.replace(/\?.*$/, "")}: ${err instanceof Error ? err.message : err}`);
      const text = await res.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* text */ }
      throw new HttpError(res.status, url, body);
    }
    await sleep(Math.min(30_000, 1000 * 2 ** attempt));
  }
}

/** The project's current server, through REST API v2 with a secret key of that project. */
export class HttpSource implements MoveSource {
  readonly base: string;
  label: string;
  projectId: string | null = null;
  constructor(url: string, readonly key: string, readonly http: HttpOptions = {}) { this.base = trim(url); this.label = this.base; }
  exportUrl(id: string) { return this.p(`/exports/${encodeURIComponent(id)}`); }
  private headers(json = false): Record<string, string> { return { authorization: `Bearer ${this.key}`, accept: "application/json", ...(json ? { "content-type": "application/json" } : {}) }; }
  private async p(path = "") {
    if (!this.projectId) await this.project();
    return `${this.base}/v2/projects/${encodeURIComponent(this.projectId!)}${path}`;
  }
  async project() {
    const list = await requestJson<{ items: { id: string; name: string; move_state?: string | null }[] }>(`${this.base}/v2/projects`, { headers: this.headers() }, this.http);
    const p = list.items[0];
    if (!p) throw new Error("The source key cannot see a project.");
    this.projectId = p.id;
    const move = await requestJson<{ state: string | null }>(`${this.base}/v2/projects/${encodeURIComponent(p.id)}/move`, { headers: this.headers() }, this.http).catch(() => ({ state: null }));
    return { id: p.id, name: p.name, move_state: move.state };
  }
  async startExport(passphrase: string | null, purpose: "move" | "download" = "move"): Promise<ExportInfo> {
    return requestJson(await this.p("/exports"), { method: "POST", headers: this.headers(true), body: JSON.stringify({ purpose, ...(passphrase ? { passphrase } : {}) }) }, this.http);
  }
  async advanceExport(id: string): Promise<ExportInfo> {
    return requestJson(await this.p(`/exports/${encodeURIComponent(id)}/actions/advance`), { method: "POST", headers: this.headers() }, this.http);
  }
  async readFile(exportId: string, name: string) {
    return requestBytes(await this.p(`/exports/${encodeURIComponent(exportId)}/files/${name}`), { headers: { authorization: `Bearer ${this.key}` } }, this.http);
  }
  async pause() { await requestJson(await this.p("/move/pause"), { method: "POST", headers: this.headers() }, this.http); }
  async forward(toUrl: string) { await requestJson(await this.p("/move/forward"), { method: "POST", headers: this.headers(true), body: JSON.stringify({ to_url: toUrl }) }, this.http); }
  async cancel() { await requestJson(await this.p("/move/cancel"), { method: "POST", headers: this.headers() }, this.http); }
}

/** A downloaded archive (`npx revenuedot export`) as the source: files by name. It cannot pause or forward a server. */
export class ArchiveSource implements MoveSource {
  label: string;
  constructor(private files: Map<string, Uint8Array>, file: string) { this.label = file; }
  private manifest(): Manifest {
    const m = this.files.get("manifest.json");
    if (!m) throw new Error(`${this.label} has no manifest.json; is it a RevenueDot export?`);
    return JSON.parse(new TextDecoder().decode(m));
  }
  async project() { const m = this.manifest(); return { id: m.project.id, name: m.project.name ?? m.project.id, move_state: null }; }
  async startExport(): Promise<ExportInfo> { return { id: this.manifest().export_id ?? "archive", status: "succeeded" }; }
  async advanceExport(id: string): Promise<ExportInfo> { return { id, status: "succeeded" }; }
  async readFile(_e: string, name: string) {
    const b = this.files.get(name);
    if (!b) throw new Error(`${this.label} has no ${name}.`);
    return b;
  }
  async pause() { throw new Error("An archive file cannot be paused: --finish needs --from <server>."); }
  async forward() { throw new Error("An archive file cannot forward traffic: --finish needs --from <server>."); }
  async cancel() {}
}

/** The server the project moves to, through its import API and an `rdi_` import token. */
export class HttpTarget implements MoveTarget {
  readonly url: string;
  constructor(url: string, private token: string, private http: HttpOptions = {}) { this.url = trim(url); }
  private h(json = true): Record<string, string> { return { authorization: `Bearer ${this.token}`, accept: "application/json", ...(json ? { "content-type": "application/json" } : {}) }; }
  plan(manifest: Manifest) { return requestJson<{ plan: Plan }>(`${this.url}/v2/imports`, { method: "POST", headers: this.h(), body: JSON.stringify({ manifest, dry_run: true }) }, this.http); }
  begin(manifest: Manifest, passphrase: string | null, replace: boolean) {
    return requestJson<{ id: string; project_id: string; files_done: Record<string, string> }>(`${this.url}/v2/imports`, { method: "POST", headers: this.h(), body: JSON.stringify({ manifest, ...(passphrase ? { passphrase } : {}), replace }) }, this.http);
  }
  async putFile(importId: string, name: string, bytes: Uint8Array) {
    const out = await requestBytes(`${this.url}/v2/imports/${encodeURIComponent(importId)}/files/${name}`, { method: "PUT", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/octet-stream" }, body: bytes as Uint8Array<ArrayBuffer> }, this.http);
    return JSON.parse(new TextDecoder().decode(out)) as { applied: boolean };
  }
  members(importId: string, members: unknown) { return requestJson(`${this.url}/v2/imports/${encodeURIComponent(importId)}/members`, { method: "POST", headers: this.h(), body: JSON.stringify({ members }) }, this.http); }
  verify(importId: string) { return requestJson<VerifyResult>(`${this.url}/v2/imports/${encodeURIComponent(importId)}/verify`, { method: "POST", headers: this.h(false) }, this.http); }
  finish(importId: string) { return requestJson<FinishReport>(`${this.url}/v2/imports/${encodeURIComponent(importId)}/finish`, { method: "POST", headers: this.h(false) }, this.http); }
}

/** Creates an export on a server, drives it to the end and returns it (`npx revenuedot export`). */
export async function exportArchive(src: HttpSource, passphrase: string | null, progress?: (m: string) => void): Promise<ExportInfo & { download_url?: string }> {
  let e = await src.startExport(passphrase, "download");
  while (e.status === "queued" || e.status === "running") {
    progress?.(`Exporting… table ${(e.progress?.table ?? 0) + 1}`);
    e = await src.advanceExport(e.id);
  }
  if (e.status !== "succeeded") throw new Error(`The export failed: ${e.error ?? e.status}`);
  return requestJson(await src.exportUrl(e.id), { headers: { authorization: `Bearer ${src.key}`, accept: "application/json" } }, src.http);
}
