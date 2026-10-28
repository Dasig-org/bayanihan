import { sha256Hex } from "@bayanihan/core";

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const ALLOWED_TYPES = [/^image\/(jpeg|png|webp|heic|gif)$/, /^application\/pdf$/, /^text\/(plain|csv)$/,
  /^application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)$/];

export type FileMeta = { hash: string; contentType: string; size: number; uploadedBy: string; showsMinors: boolean };
export interface FileStore {
  put(bytes: Uint8Array, meta: Omit<FileMeta, "hash" | "size">): Promise<FileMeta>;
  get(hash: string): Promise<{ bytes: Uint8Array; meta: FileMeta } | null>;
}

export async function sha256hex(bytes: Uint8Array) { return sha256Hex(bytes); }

export function memoryFiles(): FileStore {
  const m = new Map<string, { bytes: Uint8Array; meta: FileMeta }>();
  return {
    async put(bytes, meta) { const hash = await sha256hex(bytes); const full = { ...meta, hash, size: bytes.byteLength }; if (!m.has(hash)) m.set(hash, { bytes, meta: full }); return m.get(hash)!.meta; },
    async get(hash) { return m.get(hash) ?? null; },
  };
}
