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
}

const ini: BixResource = { resourceType: "Initiative", id: "LU 2027", meta: { version: 1 }, title: "LU 2027", kind: "project", status: "active", organization: R("Organization/cebu-wp") };
const team: BixResource = { resourceType: "Team", id: "comms", meta: { version: 1 }, name: "Communications", organization: R("Organization/cebu-wp"), initiative: R("Initiative/LU 2027"),
  participant: [{ person: R("Person/mia"), role: "volunteer", status: "active" }] };
const task: BixResource = { resourceType: "Task", id: "77777777-7777-4777-8777-777777777777", meta: { version: 1 }, intent: "plan", status: "accepted", title: "Speaker form",
  owner: R("Person/mia"), participant: [{ person: R("Person/mia"), role: "owner", status: "active" }], partOf: R("Initiative/LU 2027") };

describe("signed when done", () => {
  it("signs completed work with the group's key; anyone can check it; tampering shows", async () => {
    const store = new HistoryStore();
    for (const r of [ini, team, task]) store.put(r);
    const app = createApp({ store, keys: memoryKeys(), async identify(req) { return { person: req.headers.get("x-bix-person") }; }, now: () => "2026-11-04T16:10:00+08:00", newId });
    const done = { ...task, status: "completed", meta: { version: 2 } };
    const res = await app.request("/", { method: "POST", headers: { "content-type": "application/json", "x-bix-person": "Person/mia" }, body: JSON.stringify({ type: "transaction", entry: [{ resource: done }] }) });
    expect(res.status).toBe(200);

    const check = await (await app.request(`/Task/${task.id}/$verify`, { headers: { "x-bix-person": "Person/mia" } })).json();
    expect(check.signatures[0]).toMatchObject({ version: 2, signedBy: "Organization/cebu-wp", unchanged: true });
    expect(check.allValid).toBe(true);

    const key = await (await app.request("/$keys/Organization/cebu-wp")).json();
    expect(key.alg).toBe("Ed25519");

    // Someone edits the stored version directly: the check now fails.
    const v2 = store.hist.find((x) => x.meta.version === 2)!;
    (v2 as Record<string, unknown>)["title"] = "Speaker form (and the whole website)";
    const again = await (await app.request(`/Task/${task.id}/$verify`, { headers: { "x-bix-person": "Person/mia" } })).json();
    expect(again.allValid).toBe(false);
  });
});
