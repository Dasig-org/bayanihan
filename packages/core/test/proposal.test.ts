import { describe, expect, it } from "vitest";
import { acceptProposal, applyChange, applyPatch, closeProposal, isOutdated, proposalsToWithdraw, proposeChange, type BixResource } from "../src/index.js";

/** BIX "Proposed edits and assistance" (2026-11-11): ChangeProposal, Organization.assist[], rules 3 and 20–22. */
const R = (r: string) => ({ reference: r });
const id = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const now = "2026-11-20T21:14:00+08:00";
const newId = () => crypto.randomUUID();
const area = (code: string) => ({ system: "bayanihan:assist-area", code });

const org = (assist: string[] = ["review-plan", "break-down"]): BixResource =>
  ({ resourceType: "Organization", id: id(1), meta: { version: 1 }, name: "Runners club", assist: assist.map(area) });
const task: BixResource = { resourceType: "Task", id: id(2), meta: { version: 4 }, intent: "plan", status: "ready", title: "Water stations",
  team: R("Team/program"), owner: R("Team/program"), partOf: R(`Initiative/${id(9)}`) };
const proposal = (over: Record<string, unknown> = {}): BixResource => ({ resourceType: "ChangeProposal", id: id(3), meta: { version: 1 },
  target: R(`Task/${id(2)}`), basedOn: 4, organization: R(`Organization/${id(1)}`), area: area("review-plan"),
  reason: "Projects like this put water stations under Logistics.",
  change: [{ op: "replace", path: "/owner", value: R("Team/logistics") }], status: "draft", ...over });
const draftStep = (n: number, title: string): BixResource => ({ resourceType: "Task", id: id(n), meta: { version: 1 }, intent: "proposal", status: "draft",
  title, team: R("Team/program"), owner: R("Team/program"), partOf: R(`Task/${id(2)}`) });

const bayani = (o = org()) => ({ actor: { type: "model" as const, model: { name: "Bayani-1-1B", version: "0.1" }, onBehalfOf: R("Person/ana") }, permissions: [], now, newId, organization: o });
const person = (who: string, permissions: string[] = []) => ({ actor: { type: "person" as const, person: R(who) }, permissions, now, newId });
const lead = person("Person/ana", ["task.assign", "initiative.plan"]);

describe("making a proposal", () => {
  it("lets Bayani propose an edit in an area the group turned on, as a draft with Provenance naming the model", () => {
    const r = proposeChange(proposal(), task, [], bayani());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.records[0]!["status"]).toBe("draft");
    expect(r.provenance[0]!["activity"]).toBe("propose");
    expect(r.provenance[0]!["agent"]).toEqual([{ type: "model", model: { name: "Bayani-1-1B", version: "0.1" } }, { type: "author", who: R("Person/ana") }]);
  });

  it("refuses a model outside the group's areas, or without an area or a reason (rule 22)", () => {
    expect(proposeChange(proposal(), task, [], bayani(org([]))).ok).toBe(false);
    expect(proposeChange(proposal({ area: undefined }), task, [], bayani()).ok).toBe(false);
    expect(proposeChange(proposal({ reason: " " }), task, [], bayani()).ok).toBe(false);
  });

  it("lets a person propose without an area or reason", () => {
    expect(proposeChange(proposal({ area: undefined, reason: undefined }), task, [], { ...person("Person/mia"), organization: org([]) }).ok).toBe(true);
  });

  it("refuses a proposal made against an old version", () => {
    const r = proposeChange(proposal({ basedOn: 3 }), task, [], bayani());
    expect(r.ok).toBe(false);
  });

  it("refuses what no proposal may touch (rule 21)", () => {
    const bad = (change: unknown[], t: BixResource = task) => proposeChange(proposal({ change, target: R(`${t.resourceType}/${t.id}`) }), t, [], bayani());
    expect(bad([{ op: "replace", path: "/owner", value: R("Person/josh") }]).ok).toBe(false);
    expect(bad([{ op: "add", path: "/verification", value: "confirmed" }]).ok).toBe(false);
    const withPeople = { ...task, participant: [{ person: R("Person/josh"), role: "helper", status: "active" }] } as BixResource;
    expect(bad([{ op: "add", path: "/participant/0/attended", value: { at: now, by: R("Person/josh") } }], withPeople).ok).toBe(false);
    const o = org();
    expect(bad([{ op: "replace", path: "/assist", value: [area("roster")] }], o).ok).toBe(false);
  });

  it("refuses an edit that would make the record invalid, or a path that doesn't exist", () => {
    expect(proposeChange(proposal({ change: [{ op: "replace", path: "/status", value: "nonsense" }] }), task, [], bayani()).ok).toBe(false);
    expect(proposeChange(proposal({ change: [{ op: "remove", path: "/nothing" }] }), task, [], bayani()).ok).toBe(false);
  });
});

describe("accepting and closing", () => {
  it("applies the edit as one new version of the target, and marks the proposal accepted (rule 20)", () => {
    const r = acceptProposal(proposal(), task, [], lead);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [t, p] = r.records;
    expect(t!["owner"]).toEqual(R("Team/logistics"));
    expect(t!.meta.version).toBe(5);
    expect(p!["status"]).toBe("accepted");
    expect(r.provenance.map((x) => x["activity"])).toEqual(["update", "update"]);
  });

  it("never applies a proposal whose target moved on; a rule marks it outdated", () => {
    const moved = { ...task, meta: { version: 5 } } as BixResource;
    const r = acceptProposal(proposal(), moved, [], lead);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outdated).toBe(true);
    expect(isOutdated(proposal(), moved)).toBe(true);
    expect(closeProposal(proposal(), [], "outdated", lead).ok).toBe(false);
    const byRule = closeProposal(proposal(), [], "outdated", { actor: { type: "rule", rule: "outdated" }, permissions: [], now, newId });
    expect(byRule.ok && byRule.records[0]!["status"]).toBe("outdated");
  });

  it("splits a step: the smaller steps are proposed together and become ready together", () => {
    const steps = [draftStep(10, "List prospects"), draftStep(11, "Send letters")];
    const split = proposal({ change: undefined, includes: steps.map((s) => R(`Task/${s.id}`)), area: area("break-down"), reason: "Looks like several steps." });
    expect(proposeChange(split, task, steps, bayani()).ok).toBe(true);
    const r = acceptProposal(split, task, steps, lead);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.records.slice(0, 2).map((x) => [x["intent"], x["status"]])).toEqual([["plan", "ready"], ["plan", "ready"]]);
    // Accepting drafts needs a lead, exactly as making them directly would.
    expect(acceptProposal(split, task, steps, person("Person/mia")).ok).toBe(false);
  });

  it("declining cancels the proposal's drafts; the author can withdraw their own without a lead's permission", () => {
    const steps = [draftStep(10, "List prospects")];
    const split = proposal({ change: undefined, includes: [R(`Task/${id(10)}`)] });
    const d = closeProposal(split, steps, "declined", lead);
    expect(d.ok && d.records.map((x) => x["status"])).toEqual(["cancelled", "declined"]);
    expect(closeProposal(split, steps, "withdrawn", person("Person/mia")).ok).toBe(false);
    expect(closeProposal(split, steps, "withdrawn", { ...person("Person/mia"), closesOwnDraft: true }).ok).toBe(true);
  });

  it("appends to a list the record doesn't have yet (/dependsOn/-)", () => {
    const after = applyPatch(task, [{ op: "add", path: "/dependsOn", value: [R(`Task/${id(7)}`)] }]);
    expect(after["dependsOn"]).toEqual([R(`Task/${id(7)}`)]);
    const p = proposal({ change: [{ op: "add", path: "/dependsOn/-", value: R(`Task/${id(7)}`) }] });
    const r = acceptProposal(p, task, [], lead);
    expect(r.ok && r.records[0]!["dependsOn"]).toEqual([R(`Task/${id(7)}`)]);
  });
});

describe("a group's assistance areas", () => {
  it("only a person with org.manage turns assistance on or off", () => {
    const before = org([]), after = { ...org(["roster"]), meta: { version: 2 } } as BixResource;
    expect(applyChange(before, after, person("Person/ana", ["org.manage"])).ok).toBe(true);
    expect(applyChange(before, after, person("Person/mia", ["task.assign"])).ok).toBe(false);
  });

  it("turning an area off lists its open proposals for withdrawal", () => {
    const open = [proposal(), proposal({ id: id(4), area: area("break-down") }), proposal({ id: id(5), status: "accepted" })];
    expect(proposalsToWithdraw(open, org(["break-down"])).map((p) => p.id)).toEqual([id(3)]);
  });
});
