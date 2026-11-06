import { describe, expect, it } from "vitest";
import { authorize, isCoreTeam, type BixResource, type Directory } from "../src/index.js";

/** BIX "Seeing other committees' work": who sees what inside one group. */
const m = { version: 1 };
const R = (r: string) => ({ reference: r });
const org = "Organization/club", run = "Initiative/run", other = "Initiative/other";
const role = (person: string, code: string, permissions: string[] = []): BixResource => ({ resourceType: "Role", id: person, meta: m, person: R(`Person/${person}`), organization: R(org), code: { code }, status: "active", ...(permissions.length ? { permissions: permissions.map((code) => ({ code })) } : {}) });
const team = (id: string, ini: string, people: [string, string][], extra: Partial<BixResource> = {}): BixResource =>
  ({ resourceType: "Team", id, meta: m, name: id, organization: R(org), initiative: R(ini), participant: people.map(([p, r]) => ({ person: R(`Person/${p}`), role: r, status: "active" })), ...extra });
const dir = (teams: BixResource[], extraRoles: BixResource[] = []): Directory => ({
  roles: [role("ana", "officer"), role("cora", "core-member"), role("mel", "member"), role("vic", "volunteer-episodic"), role("sam", "service-learning"), ...extraRoles],
  positions: [],
  teams,
  initiatives: [{ resourceType: "Initiative", id: "run", meta: m, organization: R(org) }, { resourceType: "Initiative", id: "other", meta: m, organization: R(org) }],
});
const route = team("route", run, [["mel", "member"], ["vic", "volunteer"]]);
const comms = team("comms", run, []);
const task = (t: string, over: Partial<BixResource> = {}): BixResource => ({ resourceType: "Task", id: `${t}-task`, meta: m, intent: "plan", status: "ready", team: R(`Team/${t}`), owner: R(`Team/${t}`), audience: "team", ...over });
const sees = (who: string, rec: BixResource, d: Directory) => authorize(`Person/${who}`, "view", rec, d).allowed;

describe("core team and volunteers (Role.code)", () => {
  it("officer, core-member and member are the core team; volunteers, students, partners and donors are not", () => {
    expect(["officer", "core-member", "member"].every(isCoreTeam)).toBe(true);
    expect(["volunteer-regular", "volunteer-episodic", "service-learning", "partner-representative", "donor"].some(isCoreTeam)).toBe(false);
  });
});

describe("seeing other committees' work", () => {
  const d = dir([route, comms]);
  it("officers and core members see every committee", () => {
    expect(sees("ana", task("comms"), d)).toBe(true);
    expect(sees("cora", task("comms"), d)).toBe(true);
  });
  it("a member sees every committee in a project they're on", () => {
    expect(sees("mel", task("comms"), d)).toBe(true);
  });
  it("a member doesn't see the work of a project they're not on, but can see the project itself", () => {
    const d2 = dir([route, team("venue", other, [])]);
    expect(sees("mel", task("venue"), d2)).toBe(false);
    expect(sees("mel", { resourceType: "Initiative", id: "other", meta: m, organization: R(org) }, d2)).toBe(true);
  });
  it("a committee can keep its work to itself, even from members on the project", () => {
    const d2 = dir([route, team("comms", run, [], { visibility: "team" })]);
    expect(sees("mel", task("comms"), d2)).toBe(false);
    expect(sees("cora", task("comms"), d2)).toBe(true);
  });
  it("a volunteer sees their own committee and not the others", () => {
    expect(sees("vic", task("route"), d)).toBe(true);
    expect(sees("vic", task("comms"), d)).toBe(false);
    expect(sees("vic", comms, d)).toBe(false);
  });
  it("a volunteer sees the project they're on, but not one they aren't", () => {
    expect(sees("vic", { resourceType: "Initiative", id: "run", meta: m, organization: R(org) }, d)).toBe(true);
    expect(sees("vic", { resourceType: "Initiative", id: "other", meta: m, organization: R(org) }, d)).toBe(false);
  });
  it("a volunteer sees work offered to the whole group or to outsiders", () => {
    expect(sees("vic", task("comms", { audience: "organization" }), d)).toBe(true);
    expect(sees("sam", task("comms", { audience: "open" }), d)).toBe(true);
  });
  it("a volunteer sees what they're on, wherever it is", () => {
    expect(sees("vic", task("comms", { participant: [{ person: R("Person/vic"), role: "helper", status: "active" }] }), d)).toBe(true);
  });
  it("an organizer can widen a volunteer's view: the whole project through Team.access, everything through view.organization", () => {
    const d2 = dir([team("route", run, [["vic", "volunteer"]], { access: "initiative" }), comms]);
    expect(sees("vic", task("comms"), d2)).toBe(true);
    const d3 = dir([route, comms], [role("vic", "volunteer-episodic", ["view.organization"])]);
    expect(sees("vic", task("comms"), d3)).toBe(true);
  });
  it("public work is still public, and private work still private", () => {
    expect(sees("vic", task("comms", { sharing: "public" }), d)).toBe(true);
    expect(sees("mel", task("comms", { sharing: "private" }), d)).toBe(false);
  });
});
