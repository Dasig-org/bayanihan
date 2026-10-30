import { describe, expect, it } from "vitest";
import { MemoryStore, type BixResource } from "@bayanihan/core";
import { createApp } from "../src/app.js";
import { memoryLinkTokens } from "../src/links.js";

const R = (r: string) => ({ reference: r });
const m = { version: 1 };
function setup() {
  const store = new MemoryStore();
  const org: BixResource = { resourceType: "Organization", id: "lahug-runners", meta: m, name: "Lahug Uplands Runners Club", kind: "community" };
  const ini: BixResource = { resourceType: "Initiative", id: "lahug-run", meta: m, title: "Lahug Uplands Fun Run 2027", kind: "project", status: "active", organization: R("Organization/lahug-runners") };
  const don: BixResource = { resourceType: "Person", id: "don", meta: m, name: { text: "Don", use: "nickname" } };
  const role: BixResource = { resourceType: "Role", id: "r1", meta: m, person: R("Person/don"), organization: R("Organization/lahug-runners"), code: { system: "bayanihan:role", code: "officer" }, status: "active" };
  const team: BixResource = { resourceType: "Team", id: "c0c0c0c0-0000-4000-8000-000000000001", meta: m, name: "Communications", organization: R("Organization/lahug-runners"), initiative: R("Initiative/lahug-run"), participant: [{ person: R("Person/don"), role: "lead", status: "active" }] };
  for (const r of [org, ini, don, role, team]) store.put(r);
  const roles = () => store.all().filter((x) => x.resourceType === "Role");
  const app = createApp({ store: Object.assign(store, { async search(type: string, q: Record<string, string>) { return store.all().filter((x) => x.resourceType === type && Object.entries(q).every(([k, v]) => (x[k] as { reference?: string })?.reference === v || x[k] === v)); } }),
    linkTokens: memoryLinkTokens(), async identify(req) { return { person: req.headers.get("x-bix-person") }; }, now: () => "2026-11-04T10:00:00+08:00", newId: () => crypto.randomUUID() });
  const call = (path: string, who: string | null, body?: unknown) => app.request(path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(who ? { "x-bix-person": who } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { store, roles, call };
}

describe("invite links", () => {
  it("Don makes an invite; Mia opens it, sees the team, and joins as a volunteer with a Role", async () => {
    const { call, store, roles } = setup();
    const made = await (await call("/$links", "Person/don", { target: R("Team/c0c0c0c0-0000-4000-8000-000000000001"), grants: ["view", "join-team"] })).json();
    expect(made.token).toBeTruthy();
    const page = await (await call(`/$link/${made.token}`, null)).json();
    expect(page).toMatchObject({ title: "Communications", invitedBy: "Don", organization: { name: "Lahug Uplands Runners Club" }, project: { title: "Lahug Uplands Fun Run 2027" } });
    const joined = await call(`/$link/${made.token}/join`, "Person/mia", {});
    if (joined.status !== 200) console.log(await joined.text());
    expect(joined.status).toBe(200);
    const team = (await store.get("Team", "c0c0c0c0-0000-4000-8000-000000000001"))!;
    expect((team["participant"] as { role: string }[]).map((p) => p.role)).toEqual(["lead", "volunteer"]);
    expect(roles().some((r) => (r["person"] as { reference: string }).reference === "Person/mia")).toBe(true);
  });
  it("a made-up token opens nothing", async () => {
    const { call } = setup();
    expect((await call("/$link/not-a-real-token", null)).status).toBe(404);
  });
});
