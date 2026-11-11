import { describe, expect, it } from "vitest";
import { applyChange, computeFigure, type BixResource } from "../src/index.js";

/** BIX "Shifts, showing up and time" (2026-11-09): slots, check-in, swaps, per-person hours. */
const R = (r: string) => ({ reference: r });
const T = "00000000-0000-4000-9000-000000000001";
const base: BixResource = { resourceType: "Task", id: T, meta: { version: 1 }, intent: "plan", status: "ready", title: "Marshal at km 4",
  team: R("Team/route"), owner: R("Team/route"), partOf: R("Initiative/run"), slots: 2, participant: [] };
const as = (who: string, permissions: string[] = []) => ({ actor: { type: "person" as const, person: R(who) }, permissions, now: "2026-03-06T05:00:00+08:00", newId: () => crypto.randomUUID() });
const v = (t: BixResource, n: number, over: Partial<BixResource>) => ({ ...t, ...over, meta: { version: n } }) as BixResource;
const p = (who: string, extra: Record<string, unknown> = {}) => ({ person: R(who), role: "helper", status: "active", ...extra });

describe("slots", () => {
  it("fills places in any order and refuses one more than the work needs", () => {
    const one = v(base, 2, { participant: [p("Person/mia")] });
    expect(applyChange(base, one, as("Person/mia")).ok).toBe(true);
    const two = v(one, 3, { participant: [p("Person/mia"), p("Person/liza")] });
    expect(applyChange(one, two, as("Person/liza")).ok).toBe(true);
    const three = v(two, 4, { participant: [p("Person/mia"), p("Person/liza"), p("Person/paolo")] });
    const r = applyChange(two, three, as("Person/paolo"));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("all taken");
  });
});

describe("check-in", () => {
  const on = v(base, 2, { participant: [p("Person/mia")] });
  const checked = (by: string) => v(on, 3, { participant: [p("Person/mia", { attended: { at: "2026-03-06T04:31:00+08:00", by: R(by) } })] });
  it("the person can check themselves in", () => { expect(applyChange(on, checked("Person/mia"), as("Person/mia")).ok).toBe(true); });
  it("a lead can check someone in; another volunteer can't", () => {
    expect(applyChange(on, checked("Person/ben"), as("Person/ben", ["task.assign"])).ok).toBe(true);
    expect(applyChange(on, checked("Person/liza"), as("Person/liza")).ok).toBe(false);
  });
  it("a check-in is recorded by whoever makes it", () => { expect(applyChange(on, checked("Person/ben"), as("Person/mia")).ok).toBe(false); });
});

describe("swap", () => {
  const on = v(base, 2, { participant: [p("Person/mia")] });
  const proposed = v(on, 3, { participant: [p("Person/mia"), p("Person/liza", { status: "requested", replaces: R("Person/mia") })] });
  it("the person on it proposes; someone else can't", () => {
    expect(applyChange(on, proposed, as("Person/mia")).ok).toBe(true);
    expect(applyChange(on, proposed, as("Person/paolo")).ok).toBe(false);
  });
  it("only the named person accepts, and the replaced place ends", () => {
    const accepted = v(proposed, 4, { participant: [p("Person/mia", { status: "ended" }), p("Person/liza", { replaces: R("Person/mia") })] });
    expect(applyChange(proposed, accepted, as("Person/liza")).ok).toBe(true);
    expect(applyChange(proposed, accepted, as("Person/mia")).ok).toBe(false);
    const both = v(proposed, 4, { participant: [p("Person/mia"), p("Person/liza", { replaces: R("Person/mia") })] });
    expect(applyChange(proposed, both, as("Person/liza")).ok).toBe(false);
  });
});

describe("hours", () => {
  const per = { start: "2026-03-01T00:00:00+08:00", end: "2026-03-31T00:00:00+08:00" };
  const doneT = (over: Partial<BixResource>, people: unknown[]) => ({ ...base, status: "completed", executionPeriod: { start: "2026-03-02T08:00:00+08:00", end: "2026-03-06T08:00:00+08:00" }, participant: people, ...over }) as BixResource;
  const h = (t: BixResource) => computeFigure({ code: "sum-task-hours" }, [t], per).value;
  it("counts own period, then own hours, then the estimate; never taken-to-done (4 days here)", () => {
    expect(h(doneT({ estimate: { value: 2.5, unit: "h" } }, [p("Person/mia", { period: { start: "2026-03-06T06:00:00+08:00", end: "2026-03-06T07:30:00+08:00" } }), p("Person/liza", { hours: { value: 3, source: "stated" } }), p("Person/ben")]))).toBe(1.5 + 3 + 2.5);
    expect(h(doneT({}, [p("Person/mia")]))).toBe(0);
  });
  it("uses the shift's window, and shares a per-task estimate", () => {
    expect(h(doneT({ restriction: { period: { start: "2026-03-06T05:00:00+08:00", end: "2026-03-06T07:30:00+08:00" } } }, [p("Person/mia"), p("Person/liza")]))).toBe(5);
    expect(h(doneT({ estimate: { value: 90, unit: "min", per: "task" } }, [p("Person/mia"), p("Person/liza")]))).toBe(1.5);
  });
  it("only the person or a lead records hours", () => {
    const on = v(base, 2, { participant: [p("Person/mia")] });
    const said = v(on, 3, { participant: [p("Person/mia", { hours: { value: 2, source: "stated" } })] });
    expect(applyChange(on, said, as("Person/mia")).ok).toBe(true);
    expect(applyChange(on, said, as("Person/liza")).ok).toBe(false);
    expect(applyChange(on, said, as("Person/ben", ["task.assign"])).ok).toBe(true);
  });
});
