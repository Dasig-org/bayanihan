import { describe, expect, it } from "vitest";
import { generatePersonKey, keyIdFor, signChallenge } from "@bayanihan/core";
import { createApp, sqliteStore, hashToken } from "../src/index.js";
import { nodeDb } from "./node-db.js";

const id = () => crypto.randomUUID();
const R = (r: string) => ({ reference: r });
async function server(hub: boolean) {
  const s = await sqliteStore(nodeDb());
  const app = createApp({ store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files,
    ...(hub ? { pairingCode: () => "PAIR-1" } : { openJoin: { audience: "eco", perHour: 100 } }),
    async identify(req) { const h = req.headers.get("authorization"); return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
    now: () => new Date().toISOString(), newId: id });
  const call = (path: string, token?: string, body?: unknown) => app.request(path, { method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const tx = (t: string, ...rs: object[]) => call("/", t, { type: "transaction", entry: rs.map((resource) => ({ resource })) });
  const sync = (t: string, ...rs: object[]) => call("/", t, { type: "sync", entry: rs.map((resource) => ({ resource, occurredAt: new Date().toISOString() })) });
  return { call, tx, sync };
}

describe("taking a group to a hub and back", () => {
  it("hands over, works on the hub, and hands back with how each change travelled", async () => {
    const eco = await server(false), hub = await server(true);
    const k = await generatePersonKey();
    const pid = id(), me = `Person/${pid}`;
    const person = { resourceType: "Person", id: pid, meta: { version: 1 }, name: { text: "Ana", use: "nickname" }, credit: "nickname", sharing: "private",
      publicKey: [{ kid: keyIdFor(k.publicKey), alg: "Ed25519", key: k.publicKey, status: "active" }] };
    const { challenge } = await (await eco.call("/$challenge")).json();
    const ana = await (await eco.call("/$join", undefined, { person, challenge, proof: signChallenge(challenge, me, "eco", k.privateKey) })).json();
    const org = { resourceType: "Organization", id: id(), meta: { version: 1 }, name: "Lakbay Runners", kind: "community" };
    expect((await eco.tx(ana.token, org)).status).toBe(200);
    const ini = { resourceType: "Initiative", id: id(), meta: { version: 1 }, title: "Fun run", kind: "project", status: "active", organization: R(`Organization/${org.id}`) };
    const team = { resourceType: "Team", id: id(), meta: { version: 1 }, name: "Marshals", organization: R(`Organization/${org.id}`), initiative: R(`Initiative/${ini.id}`), participant: [{ person: R(me), role: "lead", status: "active" }] };
    const task = { resourceType: "Task", id: id(), meta: { version: 1 }, intent: "plan", status: "ready", title: "Marshal, km 4", owner: R(`Team/${team.id}`), team: R(`Team/${team.id}`), partOf: R(`Initiative/${ini.id}`), audience: "team" };
    const made = await eco.tx(ana.token, ini, team, task); if (made.status !== 200) console.log(JSON.stringify(await made.json()).slice(0, 600));
    expect(made.status).toBe(200);

    // Hand over: the cloud records the hub, and holds the group read-only.
    const h = await (await eco.call(`/Organization/${org.id}/$handover`, ana.token, { name: "Venue phone" })).json();
    expect(h.endpoint.kind).toBe("hub");
    const claimed = { ...task, meta: { version: 2 }, status: "accepted", owner: R(me), participant: [{ person: R(me), role: "owner", status: "active" }] };
    const held = await (await eco.sync(ana.token, claimed)).json();
    expect(held.refused[0].reasons[0]).toMatch(/^away-on-hub/);

    // On the hub: Ana pairs as herself, brings the group, and claims the work.
    const paired = await (await hub.call("/$pair", undefined, { code: "PAIR-1", person, proof: signChallenge("PAIR-1", me, "bix-pair", k.privateKey) })).json();
    const adopted = await (await hub.call("/$adopt", paired.token, h.bundle)).json();
    expect(adopted.kept).toBeGreaterThanOrEqual(4);
    expect((await hub.tx(paired.token, claimed)).status).toBe(200);

    // Hand back: the cloud keeps the hub's versions, marked as through the hub, and is home again.
    const back = await (await hub.call(`/Organization/${org.id}/$handback`, paired.token)).json();
    expect(back.entry.map((e: { resource: { id: string } }) => e.resource.id)).toContain(task.id);
    const done = await (await eco.call(`/Organization/${org.id}/$handback`, ana.token, back)).json();
    expect(done.refused).toEqual([]);
    expect(done.kept).toBeGreaterThanOrEqual(1);
    const there = await (await eco.call(`/Task/${task.id}`, ana.token)).json();
    expect(there.status).toBe("accepted");
    const prov = await (await eco.call(`/Task/${task.id}/$provenance`, ana.token)).json();
    expect(JSON.stringify(prov)).toContain('"kind":"hub"');
    const orgNow = await (await eco.call(`/Organization/${org.id}`, ana.token)).json();
    expect(orgNow.homeServer).toBeUndefined();
    // Writing on the cloud works again.
    const after = { ...there, meta: { version: there.meta.version + 1 }, description: "Bring water" };
    expect((await eco.tx(ana.token, after)).status).toBe(200);
    // A second hand-back is refused.
    expect((await eco.call(`/Organization/${org.id}/$handback`, ana.token, back)).status).toBe(409);
  });

  it("only an officer hands a group over", async () => {
    const eco = await server(false);
    const a = await (await eco.call("/$join", undefined, { nickname: "Ana" })).json();
    const b = await (await eco.call("/$join", undefined, { nickname: "Ben" })).json();
    const org = { resourceType: "Organization", id: id(), meta: { version: 1 }, name: "Lakbay Runners", kind: "community" };
    await eco.tx(a.token, org);
    expect((await eco.call(`/Organization/${org.id}/$handover`, b.token, {})).status).toBe(403);
  });
});
