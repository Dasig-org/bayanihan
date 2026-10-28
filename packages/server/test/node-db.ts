import { DatabaseSync } from "node:sqlite";
import type { Db } from "../src/sqlite-store.js";
/** node:sqlite adapter for tests (the phone uses expo-sqlite with the same interface). */
export function nodeDb(path = ":memory:"): Db {
  const d = new DatabaseSync(path);
  let depth = 0;
  return {
    async exec(sql) { d.exec(sql); },
    async run(sql, ...p) { const r = d.prepare(sql).run(...p); return { changes: Number(r.changes) }; },
    async all(sql, ...p) { return d.prepare(sql).all(...p) as never; },
    async tx(fn) {
      const outer = depth === 0; depth++;
      if (outer) d.exec("begin");
      try { const r = await fn(); if (outer) d.exec("commit"); return r; } catch (e) { if (outer) d.exec("rollback"); throw e; } finally { depth--; }
    },
  };
}
