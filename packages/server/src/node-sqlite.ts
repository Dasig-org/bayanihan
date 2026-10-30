import { DatabaseSync } from "node:sqlite";
import type { Db } from "./sqlite-store.js";

/** SQLite through Node's built-in driver, for a hosted server (phones use expo-sqlite with the same interface). */
export function nodeSqlite(path: string): Db {
  const d = new DatabaseSync(path);
  // WAL: readers don't block the writer, and Litestream streams the WAL to S3. busy_timeout rides out short locks.
  d.exec("pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 5000; pragma foreign_keys = on;");
  let depth = 0;
  return {
    async exec(sql) { d.exec(sql); },
    async run(sql, ...p) { const r = d.prepare(sql).run(...p); return { changes: Number(r.changes) }; },
    async all(sql, ...p) { return d.prepare(sql).all(...p) as never; },
    async tx(fn) {
      const outer = depth === 0; depth++;
      if (outer) d.exec("begin immediate");
      try { const r = await fn(); if (outer) d.exec("commit"); return r; } catch (e) { if (outer) d.exec("rollback"); throw e; } finally { depth--; }
    },
  };
}
