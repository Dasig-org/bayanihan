import { describe, expect, it } from "vitest";
import { createApp, sqliteStore, hashToken } from "../src/index.js";
import { nodeDb } from "./node-db.js";

const id = () => crypto.randomUUID();
const R = (r: string) => ({ reference: r });
const vis = (v: string) => [{ url: "bayanihan:visibility", value: v }];

async function setup() {
  const s = await sqliteStore(nodeDb());
  const app = createApp({ store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files,
    openJoin: { audience: "test", perHour: 100 },
    async identify(req) { const h = req.headers.get("authorization"); return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
    now: () => new Date().toISOString(), newId: id });
  const call = (path: string, token?: string, body?: unknown) => app.request(path, { method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const join = async (nickname: string) => (await (await call("/$join", undefined, { nickname })).json()) as { token: string; person: { id: string } };
  const tx = (token: string, ...rs: object[]) => call("/", token, { type: "transaction", entry: rs.map((resource) => ({ resource })) });
  return { call, join, tx };
}
async function group(visibility: string) {
  const t = await setup();
  const ana = await t.join("Ana");
  const org = { resourceType: "Organization", id: id(), meta: { version: 1 }, name: "Cebu Meetup", kind: "community", publicSummary: visibility === "public", extension: vis(visibility) };
  expect((await t.tx(ana.token, org)).status).toBe(200);
  const ini = { resourceType: "Initiative", id: id(), meta: { version: 1 }, title: "Meetup 12", kind: "project", status: "active", organization: R(`Organization/${org.id}`), publicSummary: false, extension: vis(visibility === "public" ? "invited" : visibility) };
  const team = { resourceType: "Team", id: id(), meta: { version: 1 }, name: "Hosts", organization: R(`Organization/${org.id}`), initiative: R(`Initiative/${ini.id}`), participant: [{ person: R(`Person/${ana.person.id}`), role: "lead", status: "active" }] };
  expect((await t.tx(ana.token, ini, team)).status).toBe(200);
  return { ...t, ana, org, ini, team };
}

describe("privacy a coordinator controls", () => {
  it("a members-only group has no invite links, and hides its summary from outsiders", async () => {
    const g = await group("group");
    expect((await g.call("/$links", g.ana.token, { target: R(`Team/${g.team.id}`), grants: ["view", "join-team"] })).status).toBe(403);
    const stranger = await g.join("Stranger");
    expect((await g.call(`/Organization/${g.org.id}`, stranger.token)).status).toBe(404);
    expect((await g.call(`/Initiative/${g.ini.id}`)).status).toBe(404);
  });
  it("an invite-only group can invite privately, and joining can wait for approval", async () => {
    const g = await group("invited");
    const link = await (await g.call("/$links", g.ana.token, { target: R(`Initiative/${g.ini.id}`), grants: ["view", "join-org"], preview: "generic", approval: true })).json();
    const peek = await (await g.call(`/$link/${link.token}`)).json();
    expect(peek.title).toBe("You're invited to a group on Dasig");
    expect(JSON.stringify(peek)).not.toContain("Cebu Meetup");
    const mia = await g.join("Mia");
    const role = await (await g.call(`/$link/${link.token}/join`, mia.token, {})).json();
    expect(role.status).toBe("requested");
    expect((await g.call(`/Initiative/${g.ini.id}`)).status).toBe(404); // still nothing public
  });
  it("refuses showing private work to everyone, and a project more open than its group", async () => {
    const g = await group("invited");
    const task = { resourceType: "Task", id: id(), meta: { version: 1 }, intent: "plan", status: "ready", title: "Bring chairs", owner: R(`Team/${g.team.id}`), team: R(`Team/${g.team.id}`), partOf: R(`Initiative/${g.ini.id}`), audience: "open" };
    const r = await g.tx(g.ana.token, task);
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).toContain("isn't public");
    expect((await g.tx(g.ana.token, { ...task, audience: "team" })).status).toBe(200);
    // A group that turns private later: work that was open is no longer shown to outsiders.
    const pub = await group("public");
    const openTask = { resourceType: "Task", id: id(), meta: { version: 1 }, intent: "plan", status: "ready", title: "Usher", owner: R(`Team/${pub.team.id}`), team: R(`Team/${pub.team.id}`), partOf: R(`Initiative/${pub.ini.id}`), audience: "open", sharing: "public" };
    const pubIni = { ...pub.ini, meta: { version: 2 }, publicSummary: true, extension: vis("public") };
    expect((await pub.tx(pub.ana.token, pubIni)).status).toBe(200);
    expect((await pub.tx(pub.ana.token, openTask)).status).toBe(200);
    const outsider = await pub.join("Outsider");
    expect((await pub.call(`/Task/${openTask.id}`, outsider.token)).status).toBe(200);
    expect((await pub.tx(pub.ana.token, { ...pub.org, meta: { version: 2 }, publicSummary: false, extension: vis("invited") })).status).toBe(200);
    expect((await pub.call(`/Task/${openTask.id}`, outsider.token)).status).toBe(404);
    const louder = { ...g.ini, meta: { version: 2 }, publicSummary: true, extension: vis("public") };
    expect(JSON.stringify(await (await g.tx(g.ana.token, louder)).json())).toContain("can't be more open than its group");
  });
});
