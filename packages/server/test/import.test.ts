import { describe, expect, it } from "vitest";
import { generatePersonKey, keyIdFor, signChallenge } from "@bayanihan/core";
import { createApp, sqliteStore, hashToken } from "../src/index.js";
import { nodeDb } from "./node-db.js";

const id = () => crypto.randomUUID();
const R = (r: string) => ({ reference: r });
async function server(join = false) {
  const s = await sqliteStore(nodeDb());
  let code: string | null = "PAIR-1";
  const app = createApp({ store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files, pairingCode: () => code,
    ...(join ? { openJoin: { audience: "eco", perHour: 100 } } : {}),
    async identify(req) { const h = req.headers.get("authorization"); return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
    now: () => new Date().toISOString(), newId: id });
  const call = (path: string, token?: string, body?: unknown) => app.request(path, { method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const tx = (t: string, ...rs: object[]) => call("/", t, { type: "transaction", entry: rs.map((resource) => ({ resource })) });
  return { call, tx };
}

describe("copying a phone's group to the Ecosystem", () => {
  it("copies the group's records once, as its officer, and signs finished work there", async () => {
    const hub = await server(), eco = await server(true);
    const k = await generatePersonKey();
    const ana = await (await hub.call("/$pair", undefined, { code: "PAIR-1", nickname: "Ana" })).json();
    const p = ana.person;
    const keyed = { ...p, meta: { version: 2 }, publicKey: [{ kid: keyIdFor(k.publicKey), alg: "Ed25519", key: k.publicKey, status: "active" }] };
    expect((await hub.tx(ana.token, keyed)).status).toBe(200);
    const org = { resourceType: "Organization", id: id(), meta: { version: 1 }, name: "Kabataan Tutors", kind: "community" };
    await hub.tx(ana.token, org);
    const ini = { resourceType: "Initiative", id: id(), meta: { version: 1 }, title: "Reading camp", kind: "project", status: "active", organization: R(`Organization/${org.id}`) };
    const team = { resourceType: "Team", id: id(), meta: { version: 1 }, name: "Tutors", organization: R(`Organization/${org.id}`), initiative: R(`Initiative/${ini.id}`), participant: [{ person: R(`Person/${p.id}`), role: "lead", status: "active" }] };
    await hub.tx(ana.token, ini, team);
    const task = { resourceType: "Task", id: id(), meta: { version: 1 }, intent: "plan", status: "ready", title: "Print worksheets", owner: R(`Team/${team.id}`), team: R(`Team/${team.id}`), partOf: R(`Initiative/${ini.id}`), audience: "team" };
    await hub.tx(ana.token, task);
    const me = R(`Person/${p.id}`), t0 = new Date().toISOString();
    const taken = { ...task, meta: { version: 2 }, status: "accepted", owner: me, participant: [{ person: me, role: "owner", status: "active" }], executionPeriod: { start: t0 } };
    await hub.tx(ana.token, taken);
    await hub.tx(ana.token, { ...taken, meta: { version: 3 }, status: "completed", executionPeriod: { start: t0, end: new Date().toISOString() } });
    const bundle = await (await hub.call(`/Organization/${org.id}/$export`, ana.token)).json();

    // Ana joins the Ecosystem as the same person (her phone's key), then copies the group.
    const { challenge } = await (await eco.call("/$challenge")).json();
    const joined = await (await eco.call("/$join", undefined, { person: keyed, challenge, proof: signChallenge(challenge, `Person/${p.id}`, "eco", k.privateKey) })).json();
    const out = await (await eco.call("/$import", joined.token, bundle)).json();
    expect(out.added).toBeGreaterThanOrEqual(5);
    expect(out.refused).toBe(0);
    const there = await (await eco.call(`/Task/${task.id}`, joined.token)).json();
    expect(there.status).toBe("completed");
    expect((await (await eco.call(`/Task/${task.id}/$verify`, joined.token)).json()).allValid).toBe(true);
    // A second copy changes nothing that's already there.
    const again = await (await eco.call("/$import", joined.token, bundle)).json();
    expect(again.added).toBe(0);
    // Someone who isn't its officer can't copy it in.
    const mia = await (await eco.call("/$join", undefined, { nickname: "Mia" })).json();
    expect((await eco.call("/$import", mia.token, bundle)).status).toBe(403);
  });
});
