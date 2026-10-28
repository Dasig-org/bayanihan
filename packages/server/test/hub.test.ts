import { describe, expect, it } from "vitest";
import type { BixResource } from "@bayanihan/core";
import { createApp, sqliteStore, hashToken } from "../src/index.js";
import { nodeDb } from "./node-db.js";

async function hub() {
  const s = await sqliteStore(nodeDb());
  let code: string | null = "PAIR-1234";
  const app = createApp({
    store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, pairingCode: () => code,
    async identify(req) {
      const h = req.headers.get("authorization");
      return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7))) : null };
    },
    now: () => new Date().toISOString(), newId: () => crypto.randomUUID(),
  });
  const call = (path: string, token: string | null, body?: unknown) =>
    app.request(path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { s, call, setCode: (c: string | null) => { code = c; } };
}
const commit = (call: Awaited<ReturnType<typeof hub>>["call"], token: string, ...rs: BixResource[]) => call("/", token, { type: "transaction", entry: rs.map((resource) => ({ resource })) });

describe("a phone hub on SQLite", () => {
  it("pairs phones by code, and runs the whole loop: group, team, task, invite, claim, done, signed", async () => {
    const { call, setCode } = await hub();
    const ana = await (await call("/$pair", null, { code: "PAIR-1234", nickname: "Ana" })).json();
    expect(ana.token).toBeTruthy();
    expect((await call("/$pair", null, { code: "WRONG", nickname: "X" })).status).toBe(403);

    const org = { resourceType: "Organization", id: crypto.randomUUID(), meta: { version: 1 }, name: "Rotaract Lahug Uplands", kind: "civic-club" };
    const ini = { resourceType: "Initiative", id: crypto.randomUUID(), meta: { version: 1 }, title: "Coastal cleanup 2027", kind: "project", status: "active", organization: { reference: `Organization/${org.id}` }, identifier: [{ system: "bayanihan:ref-prefix", value: "CC" }] };
    expect((await commit(call, ana.token, org)).status).toBe(200);
    const team = { resourceType: "Team", id: crypto.randomUUID(), meta: { version: 1 }, name: "Marshals", organization: { reference: `Organization/${org.id}` }, initiative: { reference: `Initiative/${ini.id}` }, participant: [{ person: { reference: `Person/${ana.person.id}` }, role: "lead", status: "active" }] };
    expect((await commit(call, ana.token, ini, team)).status).toBe(200);
    const task = { resourceType: "Task", id: crypto.randomUUID(), meta: { version: 1 }, intent: "plan", status: "ready", title: "Marshal, km 3", owner: { reference: `Team/${team.id}` }, team: { reference: `Team/${team.id}` }, partOf: { reference: `Initiative/${ini.id}` }, audience: "team" };
    const made = await (await commit(call, ana.token, task)).json();
    expect(made.entry[0].record.identifier[0].value).toBe("CC-1");

    const link = await (await call("/$links", ana.token, { target: { reference: `Team/${team.id}` }, grants: ["view", "join-team"] })).json();
    setCode(null); // the hub stops pairing new phones; Liza is already nearby and pairs before that in real life
    setCode("PAIR-1234");
    const liza = await (await call("/$pair", null, { code: "PAIR-1234", nickname: "Liza" })).json();
    expect((await call(`/$link/${link.token}/join`, liza.token, {})).status).toBe(200);

    const me = { reference: `Person/${liza.person.id}` };
    const claimed = { ...made.entry[0].record, meta: { version: 2 }, status: "accepted", owner: me, participant: [{ person: me, role: "owner", status: "active" }], executionPeriod: { start: new Date().toISOString() } };
    expect((await commit(call, liza.token, claimed)).status).toBe(200);
    const done = { ...claimed, meta: { version: 3 }, status: "completed", executionPeriod: { ...claimed.executionPeriod, end: new Date().toISOString() } };
    expect((await commit(call, liza.token, done)).status).toBe(200);
    const check = await (await call(`/Task/${task.id}/$verify`, liza.token)).json();
    expect(check.allValid).toBe(true);
    expect(check.signatures[0].signedBy).toBe(`Organization/${org.id}`);

    const story = await (await call(`/Person/${liza.person.id}/$export`, liza.token)).json();
    expect(story.entry.some((e: { resource: BixResource }) => e.resource.id === task.id)).toBe(true);
  });
});
