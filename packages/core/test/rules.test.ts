import { describe, expect, it } from "vitest";
import { applyChange, type Context, type BixResource } from "../src/index.js";

let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const now = "2026-11-04T16:10:00+08:00";
const don = { reference: "Person/don" }, mia = { reference: "Person/mia" };
const person = (p: { reference: string }, permissions: string[] = []): Context => ({ actor: { type: "person", person: p }, permissions, now, newId });
const task = (over: Partial<BixResource> = {}): BixResource => ({
  resourceType: "Task", id: "11111111-1111-4111-8111-111111111111", meta: { version: 1 },
  intent: "plan", status: "ready", title: "Speaker form", owner: { reference: "Team/communications" }, ...over,
});
const next = (r: BixResource, over: Partial<BixResource>): BixResource => ({ ...r, ...over, meta: { version: r.meta.version + 1 } });

describe("propose, then commit", () => {
  it("lets Bayani propose a draft, recorded as the model on someone's behalf", () => {
    const r = applyChange(null, task({ intent: "proposal", status: "draft" }), {
      actor: { type: "model", model: { name: "Bayani-1-1B", version: "0.1" }, onBehalfOf: don }, permissions: [], now, newId,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.provenance["activity"]).toBe("propose");
  });
  it("never lets a model commit", () => {
    const r = applyChange(null, task(), { actor: { type: "model", model: { name: "Bayani-1-1B", version: "0.1" }, onBehalfOf: don }, permissions: [], now, newId });
    expect(r.ok).toBe(false);
  });
  it("needs a lead to accept a volunteer's proposal", () => {
    const draft = task({ intent: "proposal", status: "draft" });
    expect(applyChange(draft, next(draft, { intent: "plan", status: "ready" }), person(mia)).ok).toBe(false);
    expect(applyChange(draft, next(draft, { intent: "plan", status: "ready" }), person(don, ["task.assign"])).ok).toBe(true);
  });
});

describe("claiming and asking", () => {
  it("lets Mia claim a ready task for herself", () => {
    const t = task();
    const r = applyChange(t, next(t, { status: "accepted", owner: mia }), person(mia));
    expect(r.ok && r.provenance["activity"]).toBe("claim");
  });
  it("refuses claiming on someone else's behalf", () => {
    const t = task();
    expect(applyChange(t, next(t, { status: "accepted", owner: don }), person(mia)).ok).toBe(false);
  });
  it("only the person asked can accept", () => {
    const asked = task({ status: "requested", owner: mia });
    expect(applyChange(asked, next(asked, { status: "accepted" }), person(don, ["task.assign"])).ok).toBe(false);
    expect(applyChange(asked, next(asked, { status: "accepted" }), person(mia)).ok).toBe(true);
  });
  it("refuses a stale change (first come, first served)", () => {
    const t = task({ meta: { version: 3 } });
    const stale = { ...t, status: "accepted", owner: mia, meta: { version: 3 } };
    const r = applyChange(t, stale, person(mia));
    expect(r.ok).toBe(false);
  });
});

describe("recorded when done", () => {
  it("counts ordinary work immediately, with no review", () => {
    const t = task({ status: "accepted", owner: mia, participant: [{ person: mia, role: "owner", status: "active" }] });
    const r = applyChange(t, next(t, { status: "completed" }), person(mia));
    expect(r.ok && r.record["verification"]).toBe("not-required");
  });
  it("asks for a second person when money or beneficiaries are involved", () => {
    const t = task({ status: "accepted", owner: mia, participant: [{ person: mia, role: "owner", status: "active" }] });
    const done = applyChange(t, next(t, { status: "completed" }), { ...person(mia), involvesMoneyOrBeneficiaries: true });
    expect(done.ok && done.record["verification"]).toBe("pending");
    if (!done.ok) return;
    const confirmSelf = applyChange(done.record, next(done.record, { verification: "confirmed" }), { ...person(mia, ["task.confirm"]), involvesMoneyOrBeneficiaries: true });
    expect(confirmSelf.ok).toBe(false);
    const confirmOther = applyChange(done.record, next(done.record, { verification: "confirmed" }), { ...person(don, ["task.confirm"]), involvesMoneyOrBeneficiaries: true });
    expect(confirmOther.ok).toBe(true);
  });
});
