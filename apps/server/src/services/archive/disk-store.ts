import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ArchiveStore } from "./store.js";

/** Archive files in a folder on the self-hosted server (REVENUEDOT_ARCHIVE_DIR). Node only: entry.node.ts passes it in. */
export function diskStore(dir: string): ArchiveStore {
  const root = resolve(dir);
  const path = (key: string) => {
    const p = resolve(join(root, key));
    if (!p.startsWith(`${root}/`)) throw new Error("archive key outside the archive folder");
    return p;
  };
  return {
    kind: "disk",
    async put(key, bytes) { const p = path(key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, bytes); },
    async get(key) { try { return new Uint8Array(await readFile(path(key))); } catch (e) { if ((e as { code?: string }).code === "ENOENT") return null; throw e; } },
    async deletePrefix(prefix) { await rm(path(prefix.replace(/\/+$/, "")), { recursive: true, force: true }); },
  };
}
