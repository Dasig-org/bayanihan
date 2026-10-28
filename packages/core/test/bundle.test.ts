import { describe, expect, it } from "vitest";
import { MemoryStore, replay, toBundle, validate, type BixResource } from "../src/index.js";

let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const R = (r: string) => ({ reference: r });
const slot: BixResource = { resourceType: "Task", id: "22222222-2222-4222-8222-222222222222", meta: { version: 1 }, intent: "plan", status: "ready", title: "Marshal, km 3", owner: R("Team/marshals"), audience: "open" };
const claim = (who: string): BixResource => ({ ...slot, status: "accepted", owner: R(who), meta: { version: 2 } });
const ctx = (who: string) => ({ actor: { type: "person" as const, person: R(who) }, permissions: [], newId });

describe("offline replay", () => {
  it("first claim to have happened wins; the other is refused with the current state", () => {
    const store = new MemoryStore();
    store.put(slot);
    const r = replay(store, [
      { record: claim("Person/liza"), occurredAt: "2026-11-01T06:12:00+08:00", context: ctx("Person/liza") },
      { record: claim("Person/rhea"), occurredAt: "2026-11-01T06:10:00+08:00", context: ctx("Person/rhea") },
    ], "2026-11-01T09:00:00+08:00");
    expect(r.accepted.map((a) => (a.record["owner"] as { reference: string }).reference)).toEqual(["Person/rhea"]);
    expect(r.refused).toHaveLength(1);
    expect((r.refused[0]!.current!["owner"] as { reference: string }).reference).toBe("Person/rhea");
    expect(r.accepted[0]!.provenance["offline"]).toBe(true);
  });
  it("packs records into a valid export Bundle", () => {
    const b = toBundle([slot], "export", "33333333-3333-4333-8333-333333333333", "2026-11-01T09:00:00+08:00");
    expect(validate(b).valid).toBe(true);
  });
});
