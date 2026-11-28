import type { BixResource } from "./validate.js";
import { applyChange, type Context } from "./rules.js";
import { rebaseOwnFacts } from "./ownfacts.js";

/** Where records live. The server backs this with Postgres; tests and the phone use memory or SQLite. */
export interface Store {
  get(type: string, id: string): Promise<BixResource | null>;
  /** Write a record (a new version) and its provenance together, or neither. */
  commit(record: BixResource, provenance: BixResource): Promise<void>;
}

export class MemoryStore implements Store {
  private m = new Map<string, BixResource>();
  async get(type: string, id: string) { return this.m.get(`${type}/${id}`) ?? null; }
  async commit(r: BixResource, p: BixResource) { this.put(r); this.put(p); }
  put(r: BixResource) { this.m.set(`${r.resourceType}/${r.id}`, r); }
  all() { return [...this.m.values()]; }
}

/** One change made on a device, possibly offline. */
export type Change = { record: BixResource; occurredAt: string; context: Omit<Context, "now" | "offline"> };
export type Replayed = {
  accepted: { record: BixResource; provenance: BixResource }[];
  /** Refused changes, with the current state, to show the person ("Rhea just took the last spot"). Never silently dropped. */
  refused: { record: BixResource; reasons: string[]; current: BixResource | null }[];
};

/**
 * Replay changes in the order they happened (rule 10). Each is checked against the store as it is now,
 * so a claim made offline loses to one that reached the home server first. Refused changes are
 * reported, never merged.
 */
export async function replay(store: Store, changes: Change[], recordedAt: string,
  opts: { baseOf?: (type: string, id: string, version: number) => Promise<BixResource | null>; via?: Context["via"] } = {}): Promise<Replayed> {
  const out: Replayed = { accepted: [], refused: [] };
  const ordered = [...changes].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  for (const c of ordered) {
    const current = await store.get(c.record.resourceType, c.record.id);
    const ctx = { ...c.context, now: c.occurredAt, offline: true, via: c.context.via ?? opts.via ?? { kind: "replayed" as const } };
    let r = applyChange(current, c.record, ctx);
    // Your own facts win: a stale change that only touches the person's own facts is put on top of the current version.
    if (!r.ok && current && opts.baseOf && c.context.actor.type === "person" && c.record.meta.version <= current.meta.version) {
      const rebased = rebaseOwnFacts(await opts.baseOf(c.record.resourceType, c.record.id, c.record.meta.version - 1), c.record, current, c.context.actor.person.reference);
      if (rebased) { const again = applyChange(current, rebased, ctx); if (again.ok) r = again; }
    }
    if (r.ok) {
      const provenance = { ...r.provenance, recorded: recordedAt };
      await store.commit(r.record, provenance);
      out.accepted.push({ record: r.record, provenance });
    } else {
      out.refused.push({ record: c.record, reasons: r.reasons, current });
    }
  }
  return out;
}

/** Package records as a BIX Bundle for sync or export (rule 18). */
export function toBundle(records: BixResource[], type: "sync" | "transaction" | "export", id: string, timestamp: string) {
  return { resourceType: "Bundle", id, type, timestamp, entry: records.map((r) => ({ fullUrl: `${r.resourceType}/${r.id}`, resource: r })) };
}
