import { describe, expect, it } from "vitest";
import { MemoryStore, type BixResource } from "@bayanihan/core";
import { createApp } from "../src/app.js";

let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const R = (r: string) => ({ reference: r });
const slot: BixResource = { resourceType: "Task", id: "44444444-4444-4444-8444-444444444444", meta: { version: 1 }, intent: "plan", status: "ready", title: "Marshal, km 3", owner: R("Team/marshals"), audience: "open" };

function setup() {
  const store = new MemoryStore();
  store.put(slot);
  const app = createApp({
    store,
    async identify(req) { const p = req.headers.get("x-bix-person"); return p ? { actor: { type: "person", person: R(p) }, permissions: [], newId } : null; },
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
