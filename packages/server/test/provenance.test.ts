import { describe, expect, it } from "vitest";
import { MemoryStore, type BixResource } from "@bayanihan/core";
import { createApp } from "../src/app.js";
import { memoryKeys } from "../src/keys.js";

let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const R = (r: string) => ({ reference: r });
class HistoryStore extends MemoryStore {
  hist: BixResource[] = [];
  async commit(r: BixResource, p: BixResource) { await super.commit(r, p); this.hist.push(r); }
  async provenanceFor(t: string) { return this.all().filter((x) => x.resourceType === "Provenance" && (x["target"] as { reference: string }[]).some((y) => y.reference.startsWith(t + "/_history/"))); }
  async version(t: string, id: string, v: number) { return this.hist.find((x) => x.resourceType === t && x.id === id && x.meta.version === v) ?? null; }
  async search(type: string, q: Record<string, string>) { return this.all().filter((x) => x.resourceType === type && Object.entries(q).every(([k, v]) => (x[k] as { reference?: string } | undefined)?.reference === v)); }
}
const u = (k: number) => `00000000-0000-4000-9000-${String(k).padStart(12, "0")}`;
const [RUN, COMMS, T1, T2, ANA, MIA, DON] = [1, 2, 3, 4, 5, 6, 7].map(u) as [string, string, string, string, string, string, string];
const org = "Organization/club";
const role = (id: string, person: string, code: string): BixResource => ({ resourceType: "Role", id, meta: { version: 1 }, person: R(person), organization: R(org), code: { system: "bayanihan:role", code }, status: "active" });
const ini: BixResource = { resourceType: "Initiative", id: RUN, meta: { version: 1 }, title: "Run", kind: "project", status: "active", organization: R(org) };
const team: BixResource = { resourceType: "Team", id: COMMS, meta: { version: 1 }, name: "Comms", organization: R(org), initiative: R(`Initiative/${RUN}`), participant: [{ person: R("Person/mia"), role: "volunteer", status: "active" }] };
const task: BixResource = { resourceType: "Task", id: T1, meta: { version: 1 }, intent: "plan", status: "accepted", title: "Poster", owner: R("Person/mia"), participant: [{ person: R("Person/mia"), role: "owner", status: "active" }], partOf: R(`Initiative/${RUN}`), team: R(`Team/${COMMS}`) };

function setup(extra: BixResource[] = []) {
  const store = new HistoryStore();
  for (const r of [ini, team, task, role(ANA, "Person/ana", "officer"), role(MIA, "Person/mia", "volunteer-episodic"), ...extra]) store.put(r);
  const app = createApp({ store, keys: memoryKeys(), async identify(req) { return { person: req.headers.get("x-bix-person") }; }, now: () => "2026-11-08T10:00:00+08:00", newId });
  const as = (who: string | null) => ({
    get: (p: string) => app.request(p, { headers: who ? { "x-bix-person": who } : {} }),
    post: (p: string, body: unknown) => app.request(p, { method: "POST", headers: { "content-type": "application/json", ...(who ? { "x-bix-person": who } : {}) }, body: JSON.stringify(body) }),
    commit: (r: BixResource) => app.request("/", { method: "POST", headers: { "content-type": "application/json", ...(who ? { "x-bix-person": who } : {}) }, body: JSON.stringify({ type: "transaction", entry: [{ resource: r }] }) }),
  });
  return { as, store };
}

describe("history, proof and checking", () => {
  it("lists each change with who did it, and marks the signed version unchanged", async () => {
    const { as } = setup();
    expect((await as("Person/mia").commit({ ...task, status: "completed", meta: { version: 2 } })).status).toBe(200);
    const h = await (await as("Person/mia").get(`/Task/${T1}/$provenance`)).json();
    const last = h.entry.at(-1);
    expect(last.activity).toBe("complete");
    expect(last.by).toBe("Person/mia");
    expect(last.signed.unchanged).toBe(true);
    expect((await as(null).get(`/Task/${T1}/$provenance`)).status).toBe(404);
  });
  it("a proof checks out for anyone, and a tampered proof doesn't", async () => {
    const { as } = setup();
    await as("Person/mia").commit({ ...task, status: "completed", meta: { version: 2 } });
    const proof = await (await as("Person/mia").get(`/Task/${T1}/$proof`)).json();
    const ok = await (await as(null).post("/$check", proof)).json();
    expect(ok.allValid).toBe(true);
    expect(ok.checks[0].title).toBe("Poster");
    const bad = structuredClone(proof); bad.entry.find((e: any) => e.resource.resourceType === "Task").resource.title = "Something else";
    expect((await (await as(null).post("/$check", bad)).json()).allValid).toBe(false);
  });
});

describe("nothing is orphaned", () => {
  it("a group keeps at least one officer", async () => {
    const { as } = setup();
    const r = await as("Person/ana").commit({ ...role(ANA, "Person/ana", "officer"), status: "ended", meta: { version: 2 } });
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).toContain("at least one officer");
  });
  it("an officer can step down once someone else is an officer", async () => {
    const { as } = setup([role(DON, "Person/don", "officer")]);
    expect((await as("Person/ana").commit({ ...role(ANA, "Person/ana", "officer"), status: "ended", meta: { version: 2 } })).status).toBe(200);
  });
  it("a project can't be moved to another group, and a task can't be left belonging to nothing", async () => {
    const { as } = setup();
    expect((await as("Person/ana").commit({ ...ini, organization: R("Organization/other"), meta: { version: 2 } })).status).toBe(409);
    const loose: BixResource = { resourceType: "Task", id: T2, meta: { version: 1 }, intent: "plan", status: "ready", title: "Loose" };
    expect((await as("Person/ana").commit(loose)).status).toBe(409);
  });
});
