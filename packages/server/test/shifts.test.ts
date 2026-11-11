import { describe, expect, it } from "vitest";
import { MemoryStore, type BixResource } from "@bayanihan/core";
import { createApp } from "../src/app.js";

/** A shift with places, through the server (BIX "Shifts, showing up and time", 2026-11-09). */
let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const R = (r: string) => ({ reference: r });
const u = (k: number) => `00000000-0000-4000-9000-${String(k).padStart(12, "0")}`;
const [RUN, ROUTE, T1] = [u(1), u(2), u(3)] as [string, string, string];
const org = "Organization/club";
const role = (id: string, person: string, code: string): BixResource => ({ resourceType: "Role", id, meta: { version: 1 }, person: R(person), organization: R(org), code: { system: "bayanihan:role", code }, status: "active" });
const people = ["mia", "liza", "paolo"];
function setup() {
  const store = new MemoryStore();
  store.put({ resourceType: "Initiative", id: RUN, meta: { version: 1 }, title: "Run", kind: "project", status: "active", organization: R(org) });
  store.put({ resourceType: "Team", id: ROUTE, meta: { version: 1 }, name: "Route", organization: R(org), initiative: R(`Initiative/${RUN}`),
    participant: people.map((p) => ({ person: R(`Person/${p}`), role: "volunteer", status: "active" })) });
  store.put({ resourceType: "Task", id: T1, meta: { version: 1 }, intent: "plan", status: "ready", title: "Marshal at km 4", slots: 2, audience: "team",
    team: R(`Team/${ROUTE}`), owner: R(`Team/${ROUTE}`), partOf: R(`Initiative/${RUN}`), participant: [] });
  people.forEach((p, i) => store.put(role(u(10 + i), `Person/${p}`, "volunteer-episodic")));
  const app = createApp({ store, async identify(req) { return { person: req.headers.get("x-bix-person") }; }, now: () => "2026-03-06T04:30:00+08:00", newId });
  const commit = (who: string, r: BixResource) => app.request("/", { method: "POST", headers: { "content-type": "application/json", "x-bix-person": who }, body: JSON.stringify({ type: "transaction", entry: [{ resource: r }] }) });
  const get = async () => (await store.get("Task", T1))!;
  return { commit, get };
}
const join = (t: BixResource, who: string, full = false) => ({ ...t, meta: { version: t.meta.version + 1 }, status: full ? "accepted" : "ready",
  participant: [...((t["participant"] as unknown[]) ?? []), { person: R(who), role: "helper", status: "active" }] }) as BixResource;

describe("a shift with places", () => {
  it("two volunteers fill it, the third is refused, and it ends up accepted with the team still owner", async () => {
    const { commit, get } = setup();
    expect((await commit("Person/mia", join(await get(), "Person/mia"))).status).toBe(200);
    expect((await commit("Person/liza", join(await get(), "Person/liza", true))).status).toBe(200);
    const t = await get();
    expect(t["status"]).toBe("accepted");
    expect((t["owner"] as { reference: string }).reference).toBe(`Team/${ROUTE}`);
    expect((await commit("Person/paolo", join(t, "Person/paolo", true))).status).toBe(409);
  });
  it("a volunteer can't add someone else, but can check themselves in", async () => {
    const { commit, get } = setup();
    expect((await commit("Person/mia", join(await get(), "Person/liza"))).status).toBe(409);
    await commit("Person/mia", join(await get(), "Person/mia"));
    const t = await get();
    const checked = { ...t, meta: { version: t.meta.version + 1 }, participant: (t["participant"] as any[]).map((x) => ({ ...x, attended: { at: "2026-03-06T04:31:00+08:00", by: R("Person/mia") } })) } as BixResource;
    expect((await commit("Person/mia", checked)).status).toBe(200);
  });
});

describe("reports", () => {
  it("an officer can send a report for the group; a volunteer can't", async () => {
    const { sqliteStore } = await import("../src/index.js"); const { nodeDb } = await import("./node-db.js");
    const store = (await sqliteStore(nodeDb())).store; const prov = () => ({ resourceType: "Provenance", id: crypto.randomUUID(), meta: { version: 1 } }) as never;
    await store.commit({ resourceType: "Role", id: u(20), meta: { version: 1 }, person: R("Person/ana"), organization: R(org), code: { system: "bayanihan:role", code: "officer" }, status: "active" } as never, prov());
    await store.commit({ resourceType: "Role", id: u(21), meta: { version: 1 }, person: R("Person/mia"), organization: R(org), code: { system: "bayanihan:role", code: "volunteer-episodic" }, status: "active" } as never, prov());
    const app = createApp({ store, async identify(req) { return { person: req.headers.get("x-bix-person") }; }, now: () => "2026-03-07T20:00:00+08:00", newId });
    const report = { resourceType: "Report", id: u(22), meta: { version: 1 }, owedBy: R(org), owedTo: R(org), period: { start: "2026-03-06T00:00:00+08:00", end: "2026-03-07T00:00:00+08:00" },
      status: "submitted", narrative: "It went well.", figures: [{ code: { system: "bayanihan:report-figure", code: "volunteers-active" }, value: 16, rule: { code: "count-tasks" }, derivedFrom: [] }] };
    const send = (who: string) => app.request("/", { method: "POST", headers: { "content-type": "application/json", "x-bix-person": who }, body: JSON.stringify({ type: "transaction", entry: [{ resource: report }] }) });
    expect((await send("Person/mia")).status).toBe(409);
    expect((await send("Person/ana")).status).toBe(200);
  });
});
