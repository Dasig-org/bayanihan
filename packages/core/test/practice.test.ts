import { describe, expect, it } from "vitest";
import {
  acceptProposal, adopt, applyChange, closeOut, computeObserved, evidence, outOfOrder, proposeChange, shareable,
  usuallyDoneByNow, usuallyNeeded, validate, withObserved, type BixResource,
} from "../src/index.js";

/** BIX "Project memory: Practices" (2026-11-13): rules 21, 23–25. */
const R = (r: string) => ({ reference: r });
const id = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const ORG = `Organization/${id(1)}`;
const run = { system: "bayanihan:initiative-category", code: "fun-run" };
const now = "2027-02-05T20:00:00+08:00";
const newId = () => crypto.randomUUID();
const rule = { actor: { type: "rule" as const, rule: "practice-figures" }, permissions: [], now, newId };
const person = (who: string, permissions: string[] = []) => ({ actor: { type: "person" as const, person: R(who) }, permissions, now, newId });
const lead = person("Person/ana", ["initiative.plan", "task.assign"]);

const project = (n: number, start: string, status = "completed"): BixResource => ({ resourceType: "Initiative", id: id(n), meta: { version: 1 },
  title: `Fun run ${n}`, kind: "project", status, organization: R(ORG), category: [run], period: { start } });
const practice = (n: number, title: string, over: Record<string, unknown> = {}): BixResource => ({ resourceType: "Practice", id: id(n), meta: { version: 1 },
  title, organization: R(ORG), status: "active", appliesTo: [run], source: "own", ...over });
const step = (n: number, of: number, p: number | null, over: Record<string, unknown> = {}): BixResource => ({ resourceType: "Task", id: id(n), meta: { version: 1 },
  intent: "plan", status: "completed", title: `Step ${n}`, partOf: R(`Initiative/${id(of)}`), team: R("Team/logistics"), owner: R("Team/logistics"),
  ...(p ? { practice: R(`Practice/${id(p)}`) } : {}), ...over });

// Three past fun runs. The permit (Practice 50) was in all three, done 30, 21 and 4 days before; added late in the third.
const past = [project(10, "2025-03-01T05:00:00+08:00"), project(11, "2025-09-06T05:00:00+08:00"), project(12, "2026-03-07T05:00:00+08:00")];
const permit = practice(50, "Get the barangay permit", { team: "Logistics" });
const marshals = practice(51, "Confirm marshals", { after: [R(`Practice/${id(50)}`)] });
const shuttle = practice(52, "Book a shuttle");
const done = (start: string, d: number) => ({ start: new Date(Date.parse(start) + d * 86_400_000).toISOString() });
const pastTasks = [
  step(100, 10, 50, { executionPeriod: done("2025-03-01T05:00:00+08:00", -30) }),
  step(101, 11, 50, { executionPeriod: done("2025-09-06T05:00:00+08:00", -21) }),
  step(102, 12, 50, { executionPeriod: done("2026-03-07T05:00:00+08:00", -4) }),
  step(103, 12, 52),
];
const recorded: Record<string, string> = {
  [`Task/${id(100)}`]: "2025-01-10T20:00:00+08:00", [`Task/${id(101)}`]: "2025-07-20T20:00:00+08:00",
  [`Task/${id(102)}`]: "2026-03-03T20:00:00+08:00", [`Task/${id(103)}`]: "2026-02-01T20:00:00+08:00",
};
const firstRecorded = (r: string) => recorded[r];

describe("calculated figures (rule 23)", () => {
  it("counts the projects, how many had the step, how many added it late, and when it was done", () => {
    const o = computeObserved(permit, past, pastTasks, firstRecorded, now);
    expect(o).toMatchObject({ ofProjects: 3, included: 3, addedLate: 1, dayFromStart: { median: -21, earliest: -30, latest: -4 }, lastSeen: "2026-03-07T05:00:00+08:00" });
    expect(o.basis).toHaveLength(3);
    expect(computeObserved(shuttle, past, pastTasks, firstRecorded, now)).toMatchObject({ ofProjects: 3, included: 1, addedLate: 0 });
  });

  it("ignores projects that aren't completed, of other kinds, or of other groups, and cancelled steps", () => {
    const other = { ...project(13, "2026-06-01T05:00:00+08:00"), category: [{ system: run.system, code: "cleanup" }] } as BixResource;
    const open = project(14, "2027-03-06T05:00:00+08:00", "active");
    const theirs = { ...project(15, "2026-05-01T05:00:00+08:00"), organization: R(`Organization/${id(2)}`) } as BixResource;
    const cancelled = step(104, 11, 52, { status: "cancelled" });
    const o = computeObserved(shuttle, [...past, other, open, theirs], [...pastTasks, cancelled], firstRecorded, now);
    expect([o.ofProjects, o.included]).toEqual([3, 1]);
  });

  it("only a rule sets the figures; the result is a valid Practice", () => {
    const next = withObserved(permit, computeObserved(permit, past, pastTasks, firstRecorded, now));
    expect(validate(next).valid).toBe(true);
    expect(applyChange(permit, next, rule).ok).toBe(true);
    expect(applyChange(permit, next, lead).ok).toBe(false);
  });

  it("no proposal may change them (rule 21)", () => {
    const withFigures = withObserved(permit, computeObserved(permit, past, pastTasks, firstRecorded, now));
    const org = { resourceType: "Organization", id: id(1), meta: { version: 1 }, name: "Runners", assist: [{ system: "bayanihan:assist-area", code: "memory" }] } as BixResource;
    const p = { resourceType: "ChangeProposal", id: id(90), meta: { version: 1 }, target: R(`Practice/${id(50)}`), basedOn: 2, organization: R(ORG),
      area: { system: "bayanihan:assist-area", code: "memory" }, reason: "x", change: [{ op: "replace", path: "/observed/included", value: 9 }], status: "draft" } as BixResource;
    const bayani = { actor: { type: "model" as const, model: { name: "Bayani-1-1B", version: "0.1" }, onBehalfOf: R("Person/ana") }, permissions: [], now, newId, organization: org };
    expect(proposeChange(p, withFigures, [], bayani).ok).toBe(false);
  });
});

describe("what rules tell a coordinator during a project", () => {
  const permitF = withObserved(permit, computeObserved(permit, past, pastTasks, firstRecorded, now));
  const shuttleF = withObserved(shuttle, computeObserved(shuttle, past, pastTasks, firstRecorded, now));
  const marshalsF = withObserved(marshals, computeObserved(marshals, past, pastTasks, firstRecorded, now));
  const thisYear = project(20, "2027-03-06T05:00:00+08:00", "active");

  it("usually needed: steps in at least half of past projects, missing from this one, with the evidence", () => {
    const s = usuallyNeeded(thisYear, [], [permitF, shuttleF, marshalsF]);
    expect(s.map((x) => x.practice["title"])).toEqual(["Get the barangay permit"]);
    expect(s[0]!.why).toBe("in 3 of your 3 projects like this; added late once");
  });

  it("starter Practices with no figures count, so a group's first project isn't empty", () => {
    const starter = practice(53, "Post the route map", { source: "starter" });
    expect(usuallyNeeded(thisYear, [], [starter]).map((x) => x.why)).toEqual(["a common step for projects like this"]);
    expect(evidence(practice(54, "New thing"))).toBe("new for your group");
  });

  it("usually done by now: the permit is usually done 21 days before; 29 days out it isn't yet", () => {
    const t = step(200, 20, 50, { status: "ready" });
    expect(usuallyDoneByNow(thisYear, [t], [permitF], "2027-02-05T05:00:00+08:00")).toHaveLength(0);
    const late = usuallyDoneByNow(thisYear, [t], [permitF], "2027-02-20T05:00:00+08:00");
    expect(late.map((x) => x.why)).toEqual(["usually done 21 days before the start"]);
  });

  it("out of order: marshals usually come after the permit, but this plan doesn't say so", () => {
    const a = step(201, 20, 50, { status: "ready" }), b = step(202, 20, 51, { status: "ready" });
    expect(outOfOrder(thisYear, [a, b], [permitF, marshalsF]).map((x) => [x.task.id, x.shouldWaitOn.id])).toEqual([[id(202), id(201)]]);
    const fixed = { ...b, dependsOn: [R(`Task/${id(201)}`)] } as BixResource;
    expect(outOfOrder(thisYear, [a, fixed], [permitF, marshalsF])).toHaveLength(0);
  });

  it("closing a project: Practices to recalculate, and steps with no Practice yet", () => {
    const c = closeOut(past[2]!, pastTasks.concat(step(105, 12, null)), [permit, shuttle, practice(55, "Plant trees", { appliesTo: [{ system: run.system, code: "cleanup" }] })]);
    expect(c.recalculate.map((p) => p.id)).toEqual([id(50), id(52)]);
    expect(c.unmatched.map((t) => t.id)).toEqual([id(105)]);
  });
});

describe("Practices in a group's hands", () => {
  it("a lead makes a draft Practice active; a member can't", () => {
    const draft = practice(56, "Thank the barangay", { status: "draft" });
    const next = { ...draft, status: "active", meta: { version: 2 } } as BixResource;
    expect(applyChange(draft, next, lead).ok).toBe(true);
    expect(applyChange(draft, next, person("Person/mia", ["task.assign"])).ok).toBe(false);
  });

  it("a lesson names the person who wrote it, unless it arrives through an accepted proposal", () => {
    const lesson = (who: string) => ({ ...permit, meta: { version: 2 }, lesson: [{ text: "Ask a month ahead.", author: R(who), time: now }] }) as BixResource;
    expect(applyChange(permit, lesson("Person/ana"), lead).ok).toBe(true);
    expect(applyChange(permit, lesson("Person/josh"), lead).ok).toBe(false);
    const p = { resourceType: "ChangeProposal", id: id(91), meta: { version: 1 }, target: R(`Practice/${id(50)}`), basedOn: 1, organization: R(ORG),
      change: [{ op: "add", path: "/lesson", value: [{ text: "Ask a month ahead.", author: R("Person/josh"), time: now }] }], status: "draft" } as BixResource;
    expect(acceptProposal(p, permit, [], lead).ok).toBe(true);
  });

  it("shared outside the group: no projects counted, no lesson authors; adopted: the group's own, with no figures (rule 25)", () => {
    const full = withObserved({ ...permit, lesson: [{ text: "Ask a month ahead.", author: R("Person/ana"), time: now, initiative: R(`Initiative/${id(12)}`) }] } as BixResource,
      computeObserved(permit, past, pastTasks, firstRecorded, now));
    const s = shareable(full);
    expect((s["observed"] as Record<string, unknown>)["basis"]).toBeUndefined();
    expect(s["lesson"]).toEqual([{ text: "Ask a month ahead.", time: now }]);
    expect(validate(s).valid).toBe(true);
    const a = adopt(s, R(`Organization/${id(3)}`), id(60));
    expect(a).toMatchObject({ source: "adopted", status: "draft", organization: R(`Organization/${id(3)}`), adoptedFrom: R(`Practice/${id(50)}`) });
    expect(a["observed"]).toBeUndefined();
    expect(validate(a).valid).toBe(true);
  });
});
