import { describe, expect, it } from "vitest";
import { createApp, sqliteStore, hashToken } from "../src/index.js";
import { alike } from "../src/app.js";
import { nodeDb } from "./node-db.js";

const id = () => crypto.randomUUID();
const R = (r: string) => ({ reference: r });
const vis = (v: string) => [{ url: "bayanihan:visibility", value: v }];

async function setup() {
  const s = await sqliteStore(nodeDb());
  const app = createApp({ store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files, openJoin: { audience: "t", perHour: 100 },
    async identify(req) { const h = req.headers.get("authorization"); return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
    now: () => new Date().toISOString(), newId: id });
  const call = (path: string, token?: string, body?: unknown) => app.request(path, { method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const join = async (n: string) => (await (await call("/$join", undefined, { nickname: n })).json()) as { token: string; person: { id: string } };
  const tx = (t: string, ...rs: object[]) => call("/", t, { type: "transaction", entry: rs.map((resource) => ({ resource })) });
  return { call, join, tx };
}
const org = (name: string, v: string, place = "Cebu City", cause = "education") => ({ resourceType: "Organization", id: id(), meta: { version: 1 }, name, kind: "civic-club",
  publicSummary: v === "public", cause: [{ system: "bayanihan:cause", code: cause }], extension: [...vis(v), { url: "bayanihan:place-text", value: place }] });

describe("finding groups, and not creating duplicates", () => {
  it("scores names that mean the same group as alike", () => {
    expect(alike("Rotaract Club of Lahug Uplands", "Lahug Uplands Rotaract")).toBeGreaterThanOrEqual(0.8);
    expect(alike("Lahug Uplands Runners Club", "Lahug Uplands Runners Meetup")).toBeGreaterThanOrEqual(0.5);
    expect(alike("Kabataan Tutors", "Lahug Uplands Runners Club")).toBe(0);
  });
  it("suggests public look-alikes but never reveals a private group", async () => {
    const t = await setup(); const ana = await t.join("Ana");
    const pub = org("Lahug Uplands Runners Club", "public"), hidden = org("Lahug Uplands Runners Meetup", "invited");
    await t.tx(ana.token, pub); await t.tx(ana.token, hidden);
    const sim = await (await t.call(`/$similar?name=${encodeURIComponent("Lahug Uplands Runners Meetup")}&place=Cebu`)).json();
    expect(sim.entry.map((e: any) => e.resource.name)).toEqual(["Lahug Uplands Runners Club"]);
    const dir = await (await t.call("/$directory?cause=education")).json();
    expect(dir.groups.map((g: any) => g.name)).toEqual(["Lahug Uplands Runners Club"]);
    expect(JSON.stringify(dir)).not.toContain("Meetup");
    // Someone who found it can ask to join; asking twice doesn't make two requests.
    const mia = await t.join("Mia");
    const ask = await (await t.call(`/Organization/${pub.id}/$ask`, mia.token, {})).json();
    expect(ask.status).toBe("requested");
    expect((await (await t.call(`/Organization/${pub.id}/$ask`, mia.token, {})).json()).id).toBe(ask.id);
    expect((await t.call(`/Organization/${hidden.id}/$ask`, mia.token, {})).status).toBe(404);
  });
  it("lists public projects of public groups, with the group's name", async () => {
    const t = await setup(); const ana = await t.join("Ana");
    const g = org("Lahug Uplands Rotaract", "public", "Lahug, Cebu City", "environment");
    await t.tx(ana.token, g);
    const ini = { resourceType: "Initiative", id: id(), meta: { version: 1 }, title: "Coastal cleanup", kind: "project", status: "active", organization: R(`Organization/${g.id}`), publicSummary: true, extension: vis("public") };
    const secret = { ...ini, id: id(), title: "Officers' retreat", publicSummary: false, extension: vis("invited") };
    await t.tx(ana.token, ini, secret);
    const dir = await (await t.call("/$directory?place=lahug")).json();
    expect(dir.projects.map((p: any) => [p.title, p.groupName])).toEqual([["Coastal cleanup", "Lahug Uplands Rotaract"]]);
  });
});
