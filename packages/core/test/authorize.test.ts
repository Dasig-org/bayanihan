import { describe, expect, it } from "vitest";
import { authorize, permissionsFor, type Directory, type BixResource } from "../src/index.js";

const m = { version: 1 };
const R = (r: string) => ({ reference: r });
const role = (id: string, person: string, org: string, code: string): BixResource => ({ resourceType: "Role", id, meta: m, person: R(person), organization: R(org), code: { system: "bayanihan:role", code }, status: "active" });
const cebu = "Organization/lahug-runners", rotaract = "Organization/rotaract-lu";
const dir: Directory = {
  roles: [
    role("r1", "Person/don", cebu, "officer"),
    role("r2", "Person/don", rotaract, "volunteer-episodic"),
    role("r3", "Person/mia", cebu, "volunteer-episodic"),
  ],
  positions: [],
  teams: [
    { resourceType: "Team", id: "comms", meta: m, name: "Communications", organization: R(cebu), initiative: R("Initiative/lahug-run"), access: "initiative",
      participant: [{ person: R("Person/don"), role: "lead", status: "active" }, { person: R("Person/mia"), role: "volunteer", status: "active" }] },
    { resourceType: "Team", id: "design", meta: m, name: "Design", organization: R(cebu), initiative: R("Initiative/lahug-run"), access: "own-tasks", participant: [] },
    { resourceType: "Team", id: "marshals", meta: m, name: "Marshals", organization: R(rotaract), initiative: R("Initiative/funrun"), participant: [{ person: R("Person/rhea"), role: "lead", status: "active" }] },
  ],
  initiatives: [
    { resourceType: "Initiative", id: "lahug-run", meta: m, title: "LU 2027", kind: "project", status: "active", organization: R(cebu) },
    { resourceType: "Initiative", id: "funrun", meta: m, title: "Fun run", kind: "project", status: "active", organization: R(rotaract) },
    { resourceType: "Initiative", id: "dons-blog", meta: m, title: "Don's civic tech notes", kind: "project", status: "active", person: R("Person/don"), sharing: "private" },
  ],
};
const task = (id: string, owner: string, over: Partial<BixResource> = {}): BixResource => ({ resourceType: "Task", id, meta: m, intent: "plan", status: "ready", owner: R(owner), ...over });

describe("one person, many groups", () => {
  it("Don leads in Lahug Uplands Runners and holds no lead permissions in the Rotaract club", () => {
    expect(permissionsFor("Person/don", cebu, undefined, dir).has("task.assign")).toBe(true);
    expect(permissionsFor("Person/don", rotaract, undefined, dir).has("task.assign")).toBe(false);
  });
  it("Don can assign Communications work, but not Rotaract marshal work", () => {
    expect(authorize("Person/don", "assign", task("t1", "Team/comms"), dir).allowed).toBe(true);
    expect(authorize("Person/don", "assign", task("t2", "Team/marshals"), dir).allowed).toBe(false);
  });
  it("as a Rotaract volunteer, Don can claim the club's open work", () => {
    expect(authorize("Person/don", "claim", task("t3", "Team/marshals", { audience: "organization" }), dir).allowed).toBe(true);
  });
  it("Mia, a Communications volunteer, can claim team work and propose, but not assign", () => {
    expect(authorize("Person/mia", "claim", task("t4", "Team/comms"), dir).allowed).toBe(true);
    expect(authorize("Person/mia", "propose", task("t4", "Team/comms"), dir).allowed).toBe(true);
    expect(authorize("Person/mia", "assign", task("t4", "Team/comms"), dir).allowed).toBe(false);
  });
  it("Communications sees Design's work because it has project-wide access", () => {
    expect(authorize("Person/mia", "view", task("t5", "Team/design", { sharing: "private" }), dir).allowed).toBe(false);
    expect(authorize("Person/mia", "view", task("t6", "Team/design"), dir).allowed).toBe(true);
  });
});

describe("personal work", () => {
  const notes = dir.initiatives[2]!;
  it("belongs to Don alone", () => {
    expect(authorize("Person/don", "edit", notes, dir).allowed).toBe(true);
    expect(authorize("Person/mia", "view", notes, dir).allowed).toBe(false);
  });
});

describe("people", () => {
  it("a person can always see their own record; others can't see a private one", () => {
    const mia: BixResource = { resourceType: "Person", id: "mia", meta: m, name: { text: "Mia" }, sharing: "private" };
    expect(authorize("Person/mia", "view", mia, dir).allowed).toBe(true);
    expect(authorize("Person/don", "view", mia, dir).allowed).toBe(false);
  });
});

describe("sharing and links", () => {
  it("strangers see a published project's summary but not its work", () => {
    expect(authorize(null, "view-summary", dir.initiatives[0]!, dir).allowed).toBe(true);
    expect(authorize(null, "view", task("t7", "Team/comms"), dir).allowed).toBe(false);
  });
  it("a share link lets a newcomer view and claim open work; revoking it closes the door", () => {
    const open = task("t8", "Team/comms", { audience: "open" });
    const link = { grants: ["view", "claim"], status: "active" };
    expect(authorize("Person/josh", "claim", open, dir, link).allowed).toBe(true);
    expect(authorize("Person/josh", "claim", open, dir, { ...link, status: "revoked" }).allowed).toBe(false);
  });
  it("a blocked person can't use the link", () => {
    const link = { grants: ["view"], status: "active", blocked: [R("Person/spammer")] };
    expect(authorize("Person/spammer", "view", task("t9", "Team/comms"), dir, link).allowed).toBe(false);
  });
});
