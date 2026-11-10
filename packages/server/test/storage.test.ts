import { describe, expect, it } from "vitest";
import { createApp, sqliteStore } from "../src/index.js";
import { nodeDb } from "./node-db.js";

/** A host's per-group storage allowance (BIX_GROUP_STORAGE_BYTES): generic, off unless set. */
const org = "Organization/club";
async function setup(perGroupBytes?: number) {
  const s = await sqliteStore(nodeDb());
  await s.store.commit({ resourceType: "Role", id: "00000000-0000-4000-9000-000000000001", meta: { version: 1 }, person: { reference: "Person/ana" }, organization: { reference: org }, code: { system: "bayanihan:role", code: "officer" }, status: "active" } as never, { resourceType: "Provenance", id: "p1", meta: { version: 1 } } as never);
  const app = createApp({ store: s.store, files: s.files, ...(perGroupBytes ? { storage: { perGroupBytes, groups: s.groupFiles } } : {}),
    async identify(req) { return { person: req.headers.get("x-bix-person") }; }, now: () => new Date().toISOString(), newId: () => crypto.randomUUID() });
  const up = (who: string, n: number, q = `?org=${org}`) => app.request(`/$files${q}`, { method: "POST", headers: { "content-type": "image/jpeg", "x-bix-person": who }, body: new Uint8Array(n).map((_, i) => (i * 7 + n) % 251) });
  const meter = async (who: string) => (await app.request("/Organization/club/$storage", { headers: { "x-bix-person": who } }));
  return { up, meter };
}

describe("per-group storage allowance", () => {
  it("counts a member's uploads, refuses the one that goes over, and shows the meter", async () => {
    const { up, meter } = await setup(1000);
    expect((await up("Person/ana", 600)).status).toBe(201);
    expect((await (await meter("Person/ana")).json())).toEqual({ used: 600, allowance: 1000 });
    expect((await up("Person/ana", 500)).status).toBe(413);
    expect((await up("Person/ana", 300)).status).toBe(201);
  });
  it("refuses uploads for a group you're not in, and hides its meter", async () => {
    const { up, meter } = await setup(1000);
    expect((await up("Person/stranger", 100)).status).toBe(403);
    expect((await meter("Person/stranger")).status).toBe(404);
  });
  it("has no limit when the host sets none", async () => {
    const { up, meter } = await setup();
    expect((await up("Person/ana", 5000)).status).toBe(201);
    expect((await (await meter("Person/ana")).json()).allowance).toBe(null);
  });
});
