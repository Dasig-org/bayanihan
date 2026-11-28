import { describe, expect, it } from "vitest";
import { applyChange, MemoryStore, rebaseOwnFacts, replay, type BixResource } from "../src/index.js";

let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const R = (r: string) => ({ reference: r });
const ctx = (who: string, permissions: string[] = []) => ({ actor: { type: "person" as const, person: R(who) }, permissions, newId });
const shift = (v: number, participant: unknown[], status = "ready"): BixResource => ({ resourceType: "Task", id: "44444444-4444-4444-8444-444444444444", meta: { version: v },
  intent: "plan", status, title: "Marshals, km 4", owner: R("Team/marshals"), slots: 2, participant });
const p = (who: string, extra: Record<string, unknown> = {}) => ({ person: R(who), role: "helper", status: "active", ...extra });

describe("your own facts win", () => {
  it("re-applies a stale check-in on top of someone else's newer change", async () => {
    const v1 = shift(1, [p("Person/ana"), p("Person/ben")], "accepted");
    const v2 = shift(2, [p("Person/ana"), p("Person/ben", { attended: { at: "2026-11-30T05:00:00Z", by: R("Person/ben") } })], "accepted");
    const mine = shift(2, [p("Person/ana", { attended: { at: "2026-11-30T05:02:00Z", by: R("Person/ana") } }), p("Person/ben")], "accepted");
    const store = new MemoryStore(); store.put(v2);
    const r = await replay(store, [{ record: mine, occurredAt: "2026-11-30T05:02:00Z", context: ctx("Person/ana") }], "2026-11-30T09:00:00Z",
      { baseOf: async (_t, _i, v) => (v === 1 ? v1 : null) });
    expect(r.refused).toHaveLength(0);
    const parts = r.accepted[0]!.record["participant"] as { attended?: unknown }[];
    expect(parts.every((x) => x.attended)).toBe(true);
    expect(r.accepted[0]!.record.meta.version).toBe(3);
    expect(r.accepted[0]!.provenance["via"]).toEqual({ kind: "replayed" });
  });
  it("leaving a full shift opens a place, even when stale", () => {
    const base = shift(1, [p("Person/ana"), p("Person/ben")], "accepted");
    const current = { ...base, meta: { version: 2 }, description: "Bring water" } as BixResource;
    const mine = shift(2, [p("Person/ana", { status: "ended" }), p("Person/ben")], "accepted");
    const out = rebaseOwnFacts(base, mine, current, "Person/ana")!;
    expect(out["status"]).toBe("ready");
    expect(out["description"]).toBe("Bring water");
    expect(applyChange(current, out, { ...ctx("Person/ana"), now: "2026-11-30T05:00:00Z" }).ok).toBe(true);
  });
  it("never re-applies joining: the last place stays first come, first served", () => {
    const base = shift(1, [p("Person/ana")]);
    const current = shift(2, [p("Person/ana"), p("Person/ben")], "accepted");
    const mine = shift(2, [p("Person/ana"), p("Person/cora")], "accepted");
    expect(rebaseOwnFacts(base, mine, current, "Person/cora")).toBeNull();
  });
  it("never re-applies a change to someone else's entry, or to other fields", () => {
    const base = shift(1, [p("Person/ana"), p("Person/ben")]);
    const current = { ...base, meta: { version: 2 } } as BixResource;
    expect(rebaseOwnFacts(base, shift(2, [p("Person/ana"), p("Person/ben", { status: "ended" })]), current, "Person/ana")).toBeNull();
    expect(rebaseOwnFacts(base, { ...shift(2, [p("Person/ana"), p("Person/ben")]), title: "Mine now" } as BixResource, current, "Person/ana")).toBeNull();
  });
  it("re-applies your own profile", () => {
    const base: BixResource = { resourceType: "Person", id: "ana", meta: { version: 1 }, name: { text: "Ana" } };
    const current = { ...base, meta: { version: 2 }, photo: { url: "x" } } as BixResource;
    const out = rebaseOwnFacts(base, { ...base, meta: { version: 2 }, name: { text: "Ana R." } } as BixResource, current, "Person/ana")!;
    expect(out["name"]).toEqual({ text: "Ana R." });
    expect(out["photo"]).toEqual({ url: "x" });
    expect(rebaseOwnFacts(base, { ...base, meta: { version: 2 }, name: { text: "x" } } as BixResource, current, "Person/ben")).toBeNull();
  });
});

describe("a group's home server", () => {
  const org: BixResource = { resourceType: "Organization", id: "55555555-5555-4555-8555-555555555555", meta: { version: 1 }, name: "Lakbay Runners" };
  const moved = { ...org, meta: { version: 2 }, homeServer: R("Endpoint/66666666-6666-4666-8666-666666666666") } as BixResource;
  it("moves only with org.manage", () => {
    expect(applyChange(org, moved, { ...ctx("Person/ana"), now: "2026-11-30T05:00:00Z" }).ok).toBe(false);
    expect(applyChange(org, moved, { ...ctx("Person/ana", ["org.manage"]), now: "2026-11-30T05:00:00Z" }).ok).toBe(true);
  });
  it("records how a change travelled", () => {
    const r = applyChange(org, moved, { ...ctx("Person/ana", ["org.manage"]), now: "2026-11-30T05:00:00Z", via: { kind: "hub", endpoint: R("Endpoint/66666666-6666-4666-8666-666666666666") } });
    expect(r.ok && r.provenance["via"]).toEqual({ kind: "hub", endpoint: R("Endpoint/66666666-6666-4666-8666-666666666666") });
  });
});
