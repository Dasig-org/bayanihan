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
  return { call, join, tx, app };
}
const org = (name: string, v: string, place = "Cebu City", cause = "education") => ({ resourceType: "Organization", id: id(), meta: { version: 1 }, name, kind: "civic-club",
  publicSummary: v === "public", cause: [{ system: "bayanihan:cause", code: cause }], extension: [...vis(v), { url: "bayanihan:place-text", value: place }] });

describe("finding groups, and not creating duplicates", () => {
  it("scores names that mean the same group as alike", () => {
    expect(alike("Rotaract Club of Lahug Uplands", "Lahug Uplands Rotaract")).toBeGreaterThanOrEqual(0.8);
    expect(alike("Lahug Uplands Runners Club", "Lahug Uplands Runners")).toBeGreaterThanOrEqual(0.5);
    expect(alike("Kabataan Tutors", "Lahug Uplands Runners Club")).toBe(0);
  });
  it("suggests public look-alikes but never reveals a private group", async () => {
    const t = await setup(); const ana = await t.join("Ana");
    const pub = org("Lahug Uplands Runners Club", "public"), hidden = org("Lahug Uplands Runners", "invited");
    await t.tx(ana.token, pub); await t.tx(ana.token, hidden);
    const sim = await (await t.call(`/$similar?name=${encodeURIComponent("Lahug Uplands Runners")}&place=Cebu`)).json();
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
  it("pages groups A to Z, with a total", async () => {
    const t = await setup(); const ana = await t.join("Ana");
    for (const n of ["Charlie Tutors", "Alpha Runners", "Bravo Cleanup", "Delta Feeding", "Hidden One"]) await t.tx(ana.token, org(n, n.startsWith("Hidden") ? "invited" : "public"));
    const p1 = await (await t.call("/$directory?offset=0&count=2")).json();
    expect(p1.total).toBe(4);
    expect(p1.groups.map((g: any) => g.name)).toEqual(["Alpha Runners", "Bravo Cleanup"]);
    const p2 = await (await t.call("/$directory?offset=2&count=2")).json();
    expect(p2.groups.map((g: any) => g.name)).toEqual(["Charlie Tutors", "Delta Feeding"]);
  });
  it("serves a listed group's logo to anyone, and never a private group's or a photo of children", async () => {
    const t = await setup(); const ana = await t.join("Ana");
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const upload = async (bytes: Uint8Array, q = "") => ((await (await t.app.request(`/$files${q}`, { method: "POST", headers: { "content-type": "image/png", authorization: `Bearer ${ana.token}` }, body: bytes as unknown as BodyInit })).json()) as { url: string }).url;
    const pubUrl = await upload(png); const kidUrl = await upload(new Uint8Array([...png, 1]), "?showsMinors=true");
    const pub = { ...org("Echo Club", "public"), image: { contentType: "image/png", url: pubUrl } };
    const hid = { ...org("Foxtrot Club", "invited"), image: { contentType: "image/png", url: pubUrl } };
    const kid = { ...org("Golf Club", "public"), image: { contentType: "image/png", url: kidUrl } };
    await t.tx(ana.token, pub); await t.tx(ana.token, hid); await t.tx(ana.token, kid);
    const dir = await (await t.call("/$directory")).json();
    const echo = dir.groups.find((g: any) => g.name === "Echo Club");
    expect(echo.logo).toBe(`/Organization/${pub.id}/$logo`);
    const res = await t.call(echo.logo);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await t.call(`/Organization/${hid.id}/$logo`)).status).toBe(404);
    expect((await t.call(`/Organization/${kid.id}/$logo`)).status).toBe(404);
  });
});
