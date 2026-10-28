import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const ALLOWED_TYPES = [/^image\/(jpeg|png|webp|heic|gif)$/, /^application\/pdf$/, /^text\/(plain|csv)$/,
  /^application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)$/];

export type FileMeta = { hash: string; contentType: string; size: number; uploadedBy: string; showsMinors: boolean };
export interface FileStore {
  put(bytes: Uint8Array, meta: Omit<FileMeta, "hash" | "size">): Promise<FileMeta>;
  get(hash: string): Promise<{ bytes: Uint8Array; meta: FileMeta } | null>;
}

export async function sha256hex(bytes: Uint8Array) {
  const d = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Bytes on local disk, named by their hash. Same file uploaded twice is stored once. */
export function diskFiles(dir: string, meta: { save(m: FileMeta): Promise<void>; load(hash: string): Promise<FileMeta | null> }): FileStore {
  return {
    async put(bytes, m) {
      const hash = await sha256hex(bytes);
      await mkdir(dir, { recursive: true });
      const path = join(dir, hash);
      try { await access(path); } catch { await writeFile(path, bytes); }
      const full = { ...m, hash, size: bytes.byteLength };
      await meta.save(full);
      return (await meta.load(hash)) ?? full;
    },
    async get(hash) {
      if (!/^[a-f0-9]{64}$/.test(hash)) return null;
      const m = await meta.load(hash);
      if (!m) return null;
      return { bytes: new Uint8Array(await readFile(join(dir, hash))), meta: m };
    },
  };
}

export function memoryFiles(): FileStore {
  const m = new Map<string, { bytes: Uint8Array; meta: FileMeta }>();
  return {
    async put(bytes, meta) { const hash = await sha256hex(bytes); const full = { ...meta, hash, size: bytes.byteLength }; if (!m.has(hash)) m.set(hash, { bytes, meta: full }); return m.get(hash)!.meta; },
    async get(hash) { return m.get(hash) ?? null; },
  };
}
