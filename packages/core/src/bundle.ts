import type { BixResource } from "./validate.js";
import { applyChange, type Context } from "./rules.js";

/** Where records live. The server backs this with Postgres; tests and the phone use memory or SQLite. */
export interface Store {
  get(type: string, id: string): BixResource | null;
  put(record: BixResource): void;
}

export class MemoryStore implements Store {
  private m = new Map<string, BixResource>();
  get(type: string, id: string) { return this.m.get(`${type}/${id}`) ?? null; }
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
export function replay(store: Store, changes: Change[], recordedAt: string): Replayed {
  const out: Replayed = { accepted: [], refused: [] };
  const ordered = [...changes].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  for (const c of ordered) {
    const current = store.get(c.record.resourceType, c.record.id);
    const r = applyChange(current, c.record, { ...c.context, now: c.occurredAt, offline: true });
    if (r.ok) {
      const provenance = { ...r.provenance, recorded: recordedAt };
      store.put(r.record);
      store.put(provenance);
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
