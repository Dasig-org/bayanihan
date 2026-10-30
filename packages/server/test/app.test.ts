import { describe, expect, it } from "vitest";
import { MemoryStore, type BixResource } from "@bayanihan/core";
import { createApp } from "../src/app.js";

let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const R = (r: string) => ({ reference: r });
const slot: BixResource = { resourceType: "Task", id: "44444444-4444-4444-8444-444444444444", meta: { version: 1 }, intent: "plan", status: "ready", title: "Marshal, km 3", owner: R("Team/marshals"), audience: "open", sharing: "public" };
const secret: BixResource = { resourceType: "Task", id: "66666666-6666-4666-8666-666666666666", meta: { version: 1 }, intent: "plan", status: "ready", title: "Budget", owner: R("Team/finance"), sharing: "private" };

function setup() {
  const store = new MemoryStore();
  store.put(slot); store.put(secret);
  const app = createApp({
    store,
    async identify(req) { return { person: req.headers.get("x-bix-person") }; },
    now: () => "2026-11-01T09:00:00+08:00",
    newId,
  });
  const post = (who: string | null, body: unknown) =>
    app.request("/", { method: "POST", headers: { "content-type": "application/json", ...(who ? { "x-bix-person": who } : {}) }, body: JSON.stringify(body) });
  return { app, store, post };
}
const claim = (who: string) => ({ ...slot, status: "accepted", owner: R(who), meta: { version: 2 } });

describe("Bayanihan Server API", () => {
  it("says what it supports at /metadata", async () => {
    const { app } = setup();
    const m = await (await app.request("/metadata")).json();
    expect(m.software.name).toBe("Bayanihan Server");
    expect(m.resourceTypes).toContain("Task");
  });
  it("reads a record by type and id", async () => {
    const { app } = setup();
    const r = await app.request(`/Task/${slot.id}`);
    expect(r.status).toBe(200);
    expect((await r.json()).title).toBe("Marshal, km 3");
  });
  it("hides a private record from someone outside it, as if it doesn't exist", async () => {
    const { app } = setup();
    expect((await app.request(`/Task/${secret.id}`, { headers: { "x-bix-person": "Person/stranger" } })).status).toBe(404);
  });
  it("refuses making yourself an officer of someone else's group", async () => {
    const { post } = setup();
    const role = { resourceType: "Role", id: "99999999-9999-4999-8999-999999999999", meta: { version: 1 }, person: R("Person/intruder"), organization: R("Organization/lahug-runners"), code: { system: "bayanihan:role", code: "officer" }, status: "active" };
    const r = await post("Person/intruder", { type: "transaction", entry: [{ resource: role }] });
    expect(r.status).toBe(409);
  });
  it("lets you ask to join a group", async () => {
    const { post } = setup();
    const role = { resourceType: "Role", id: "99999999-9999-4999-8999-999999999998", meta: { version: 1 }, person: R("Person/josh"), organization: R("Organization/lahug-runners"), code: { system: "bayanihan:role", code: "volunteer-episodic" }, status: "requested" };
    expect((await post("Person/josh", { type: "transaction", entry: [{ resource: role }] })).status).toBe(200);
  });
  it("makes whoever starts a group its officer", async () => {
    const { post, store } = setup();
    const org = { resourceType: "Organization", id: "99999999-9999-4999-8999-999999999997", meta: { version: 1 }, name: "Kabataan Tutors", kind: "informal" };
    expect((await post("Person/ana", { type: "transaction", entry: [{ resource: org }] })).status).toBe(200);
    const roles = store.all().filter((x) => x.resourceType === "Role" && (x["person"] as { reference: string }).reference === "Person/ana");
    expect((roles[0]!["code"] as { code: string }).code).toBe("officer");
  });
  it("refuses a stranger editing someone else's task", async () => {
    const { post } = setup();
    const r = await post("Person/liza", { type: "transaction", entry: [{ resource: { ...slot, title: "Something else", meta: { version: 2 } } }] });
    expect(r.status).toBe(409);
  });
  it("refuses writes from nobody", async () => {
    const { post } = setup();
    expect((await post(null, { type: "transaction", entry: [{ resource: claim("Person/liza") }] })).status).toBe(401);
  });
  it("applies a claim, then refuses the second claim on the same slot", async () => {
    const { post } = setup();
    expect((await post("Person/rhea", { type: "transaction", entry: [{ resource: claim("Person/rhea") }] })).status).toBe(200);
    const second = await post("Person/liza", { type: "transaction", entry: [{ resource: claim("Person/liza") }] });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.entry[0].current.owner.reference).toBe("Person/rhea");
  });
  it("replays an offline sync bundle and reports refusals", async () => {
    const { post } = setup();
    const res = await (await post("Person/liza", { type: "sync", entry: [{ resource: claim("Person/liza"), occurredAt: "2026-11-01T06:12:00+08:00" }] })).json();
    expect(res.accepted).toHaveLength(1);
    expect(res.refused).toHaveLength(0);
  });
});
