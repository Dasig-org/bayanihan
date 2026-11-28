import type { BixResource } from "./validate.js";

/**
 * BIX "Your own facts win" (2026-11-28). A change that arrives stale is refused (rule 16), unless everything it
 * changes is the person's own: their own entry in Task.participant (leaving their place, their check-in, their hours,
 * their period) or their own Person record. Then those fields are put on top of the current version, and the result is
 * checked like any other change. Joining a place, asking and confirming stay first come, first served.
 *
 * `base` is the version the change was made from, `mine` the stale change, `current` the record as it is now.
 * Returns the re-applied change (version current + 1), or null when it isn't only the person's own facts.
 */
export function rebaseOwnFacts(base: BixResource | null, mine: BixResource, current: BixResource | null, actor: string): BixResource | null {
  if (!base || !current || base.resourceType !== mine.resourceType || current.resourceType !== mine.resourceType) return null;
  const next = (r: BixResource) => ({ ...r, meta: { ...current.meta, version: current.meta.version + 1 } }) as BixResource;
  const keys = new Set([...Object.keys(base), ...Object.keys(mine)].filter((k) => k !== "meta"));
  const changed = [...keys].filter((k) => JSON.stringify(base[k]) !== JSON.stringify(mine[k]));
  if (!changed.length) return null;

  if (mine.resourceType === "Person") {
    if (`Person/${mine.id}` !== actor) return null;
    const out: BixResource = { ...current };
    for (const k of changed) { if (mine[k] === undefined) delete out[k]; else out[k] = mine[k]; }
    return next(out);
  }

  if (mine.resourceType !== "Task" || changed.some((k) => k !== "participant")) return null;
  type P = { person: { reference: string }; status: string; replaces?: unknown; [k: string]: unknown };
  const parts = (r: BixResource) => ((r["participant"] as P[] | undefined) ?? []);
  const id = (p: P) => `${p.person.reference}|${p.replaces ? JSON.stringify(p.replaces) : ""}`;
  const before = new Map(parts(base).map((p) => [id(p), p]));
  const after = new Map(parts(mine).map((p) => [id(p), p]));
  const mineChanged = [...new Set([...before.keys(), ...after.keys()])].filter((k) => JSON.stringify(before.get(k)) !== JSON.stringify(after.get(k)));
  for (const k of mineChanged) {
    const b = before.get(k), a = after.get(k);
    if (!b || !a) return null; // adding or removing an entry is joining or asking: first come, first served
    if (a.person.reference !== actor || a.replaces) return null;
    if (a.status !== b.status && !(b.status === "active" && ["ended", "cancelled"].includes(a.status))) return null; // only leaving
    const own = ["status", "attended", "hours", "period"];
    if ([...new Set([...Object.keys(a), ...Object.keys(b)])].some((f) => !own.includes(f) && JSON.stringify(a[f]) !== JSON.stringify(b[f]))) return null;
  }
  const now = parts(current).map((p) => {
    const k = id(p);
    if (!mineChanged.includes(k)) return p;
    return { ...p, ...after.get(k) };
  });
  if (mineChanged.some((k) => !parts(current).some((p) => id(p) === k))) return null; // their entry is gone (a lead removed it)
  const out: BixResource = { ...current, participant: now };
  // Leaving a full shift opens a place again.
  const slots = (current["slots"] as number | undefined) ?? 1;
  if (slots > 1 && current["status"] === "accepted" && now.filter((p) => p.status === "active").length < slots) out["status"] = "ready";
  return next(out);
}
