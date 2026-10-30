import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { sha256hex, type FileMeta, type FileStore } from "./files.js";

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

