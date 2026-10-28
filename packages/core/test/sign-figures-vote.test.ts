import { describe, expect, it } from "vitest";
import { generateGroupKey, signRecord, verifyRecord, canonical, computeFigure, publicFigure, countVotes, type BixResource } from "../src/index.js";

const done = (id: string, start: string, end: string, people = 1, over: Partial<BixResource> = {}): BixResource => ({
  resourceType: "Task", id, meta: { version: 3 }, intent: "plan", status: "completed", verification: "not-required",
  code: { system: "bayanihan:step", code: "tutor" }, executionPeriod: { start, end },
  participant: Array.from({ length: people }, (_, i) => ({ person: { reference: `Person/p${i}` }, role: i ? "helper" : "owner", status: "active" })), ...over,
});

describe("signed records", () => {
  it("canonical form ignores key order", () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
  });
  it("verifies a record signed by the group, and catches any edit", async () => {
    const { privateKey, publicKey } = await generateGroupKey();
    const rec = done("t1", "2026-11-04T14:00:00+08:00", "2026-11-04T16:30:00+08:00");
    const sig = await signRecord(rec, privateKey, { reference: "Endpoint/cebu-wp-cloud" }, "k1", "2026-11-04T16:31:00+08:00");
    expect(await verifyRecord(rec, sig, publicKey)).toBe(true);
    expect(await verifyRecord({ ...rec, executionPeriod: { start: "2026-11-04T09:00:00+08:00", end: "2026-11-04T16:30:00+08:00" } }, sig, publicKey)).toBe(false);
  });
});

describe("report figures", () => {
  const oct = { start: "2026-10-01T00:00:00+08:00", end: "2026-10-31T23:59:59+08:00" };
  const recs = [
    done("a", "2026-10-07T14:00:00+08:00", "2026-10-07T16:30:00+08:00", 2),
    done("b", "2026-10-09T14:00:00+08:00", "2026-10-09T16:00:00+08:00", 1),
    done("c", "2026-11-04T14:00:00+08:00", "2026-11-04T16:00:00+08:00", 1),
    done("d", "2026-10-14T14:00:00+08:00", "2026-10-14T16:00:00+08:00", 1, { verification: "pending" }),
  ];
  it("counts sessions in the period, skipping unconfirmed money/beneficiary work", () => {
    expect(computeFigure({ code: "count-tasks", params: { taskCode: "tutor" } }, recs, oct)).toEqual({ value: 2, derivedFrom: ["Task/a", "Task/b"] });
  });
  it("adds volunteer hours per person who did the work", () => {
    expect(computeFigure({ code: "sum-task-hours" }, recs, oct).value).toBe(7);
  });
  it("adds up chapters' submitted reports only", () => {
    const rep = (id: string, status: string, v: number): BixResource => ({ resourceType: "Report", id, meta: { version: 1 }, status, period: { start: "2026-10-01T00:00:00+08:00", end: "2026-10-31T00:00:00+08:00" }, figures: [{ code: { system: "bayanihan:report-figure", code: "volunteer-hours" }, value: v, rule: { code: "sum-task-hours" } }] });
    const r = computeFigure({ code: "sum-part-reports", params: { figureCode: "volunteer-hours" } }, [rep("x", "submitted", 78), rep("y", "acknowledged", 40), rep("z", "in-preparation", 99)], oct);
    expect(r.value).toBe(118);
  });
  it("hides small numbers in public views", () => {
    expect(publicFigure(3)).toBe("fewer than 5");
    expect(publicFigure(0)).toBe("0");
    expect(publicFigure(18)).toBe("18");
  });
});

describe("votes", () => {
  const leads = ["don", "aya", "rhea", "ben", "mia"].map((p) => ({ reference: `Person/${p}` }));
  const decision: BixResource = { resourceType: "Decision", id: "d1", meta: { version: 2 }, question: "Which design concept?", method: "choose-one", status: "closed", eligible: leads, closes: "2026-11-07T18:00:00+08:00", quorum: 3 };
  const vote = (p: string, c: string, cast: string): BixResource => ({ resourceType: "Vote", id: `${p}-${cast}`, meta: { version: 1 }, decision: { reference: "Decision/d1" }, voter: { reference: `Person/${p}` }, choice: [c], cast });
  it("counts the last vote per eligible voter before closing", () => {
    const o = countVotes(decision, [
      vote("don", "A", "2026-11-05T10:00:00+08:00"), vote("don", "B", "2026-11-06T10:00:00+08:00"),
      vote("aya", "B", "2026-11-05T11:00:00+08:00"), vote("rhea", "A", "2026-11-05T12:00:00+08:00"),
      vote("ben", "B", "2026-11-08T09:00:00+08:00"), vote("stranger", "A", "2026-11-05T12:00:00+08:00"),
    ]);
    expect(o).toEqual({ status: "decided", option: ["B"], tally: { B: 2, A: 1 } });
  });
  it("reports no quorum instead of guessing", () => {
    expect(countVotes(decision, [vote("don", "A", "2026-11-05T10:00:00+08:00")]).status).toBe("no-quorum");
  });
});
