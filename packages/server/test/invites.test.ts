import { describe, expect, it } from "vitest";
import { createApp, hashToken, sqliteStore } from "../src/index.js";
import { handleWhy } from "../src/invites.js";
import { nodeDb } from "./node-db.js";

/** BIX "Usernames and invitations" (2026-11-13): usernames, invitations by username, person and email, privacy rules. */
async function net() {
  const s = await sqliteStore(nodeDb());
  const mail: { to: string; subject: string; text: string }[] = [];
  const app = createApp({ store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files, openJoin: { audience: "https://x", perHour: 99 },
    invites: s.invites, inviteSalt: "test-salt", inviteEmail: async (to, subject, text) => { mail.push({ to, subject, text }); },
    email: { identities: s.identities, codes: s.emailCodes, send: async () => {} },
    async identify(req) { const h = req.headers.get("authorization"); return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
    now: () => new Date().toISOString(), newId: () => crypto.randomUUID() });
  let ip = 0;
  const call = async (path: string, body?: unknown, tok?: string) => { const r = await app.request(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-forwarded-for": `10.2.${++ip % 250}.${ip % 7}`, ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: (await r.json().catch(() => ({}))) as any }; };
  const join = async (n: string) => (await call("/$join", { nickname: n })).json as { token: string; person: { id: string } };
  const tx = async (tok: string, ...rs: any[]) => call("/", { resourceType: "Bundle", type: "transaction", entry: rs.map((resource) => ({ resource })) }, tok);
  const ana = await join("Ana"), mia = await join("Mia"), vic = await join("Vic");
  const O = crypto.randomUUID(), T = crypto.randomUUID();
  await tx(ana.token, { resourceType: "Organization", id: O, meta: { version: 1 }, name: "Lahug Runners" });
  await tx(ana.token, { resourceType: "Role", id: crypto.randomUUID(), meta: { version: 1 }, status: "active", person: { reference: `Person/${vic.person.id}` }, organization: { reference: `Organization/${O}` }, code: { system: "bayanihan:role", code: "volunteer-regular" } });
  await tx(ana.token, { resourceType: "Team", id: T, meta: { version: 1 }, name: "Water", organization: { reference: `Organization/${O}` }, kind: "standing", status: "active", participant: [] });
  // Mia links an email the way sign-in does (identity with a verified label).
  await s.identities.link("email", "mia@example.org", `Person/${mia.person.id}`, "mia@example.org");
  return { s, call, tx, mail, ana, mia, vic, O, T };
}

describe("usernames", () => {
  it("follow the rules", () => {
    expect(handleWhy("ana.cebu")).toBeNull();
    for (const bad of ["ab", "Ana", "1ana", "ana..cebu", "ana.", ".ana", "admin", "dasig.help", "a".repeat(21), "ana@cebu"]) expect(handleWhy(bad)).not.toBeNull();
  });
  it("are unique, found only exactly, show only nickname and photo, and can be hidden", async () => {
    const { call, ana, mia } = await net();
    expect((await call("/$me/handle", { value: "mia.cebu" }, mia.token)).status).toBe(200);
    expect((await call("/$me/handle", { value: "mia.cebu" }, ana.token)).status).toBe(409);
    expect((await call("/$handle/mia.ceb", undefined, ana.token)).status).toBe(404);
    const found = (await call("/$handle/MIA.CEBU", undefined, ana.token)).json;
    expect(Object.keys(found).sort()).toEqual(["handle", "name", "person"]);
    await call("/$me/handle", { findable: false }, mia.token);
    expect((await call("/$handle/mia.cebu", undefined, ana.token)).status).toBe(404);
  });
  it("can't be set through a plain record edit", async () => {
    const { call, tx, mia } = await net();
    const p = (await call(`/Person/${mia.person.id}`, undefined, mia.token)).json;
    expect((await tx(mia.token, { ...p, meta: { version: p.meta.version + 1 }, handle: { value: "sneaky" } })).status).toBe(409);
  });
});

describe("invitations", () => {
  it("by username: the invitee accepts and joins the team; only the core team may send", async () => {
    const { call, ana, mia, vic, T } = await net();
    await call("/$me/handle", { value: "mia.cebu" }, mia.token);
    expect((await call("/$invite", { target: { reference: `Team/${T}` }, handle: "mia.cebu" }, vic.token)).status).toBe(403); // a volunteer, default policy
    expect((await call("/$invite", { target: { reference: `Team/${T}` }, handle: "mia.cebu" }, ana.token)).json.sent).toBe(true);
    const list = (await call("/$invitations", undefined, mia.token)).json.entry;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ role: "team-member", group: { name: "Lahug Runners" }, invitedBy: { name: "Ana" } });
    expect((await call(`/$invitations/${list[0].id}`, { answer: "accept" }, ana.token)).status).toBe(403); // not the inviter's to accept
    expect((await call(`/$invitations/${list[0].id}`, { answer: "accept" }, mia.token)).json.status).toBe("accepted");
    const team = (await call(`/Team/${T}`, undefined, ana.token)).json;
    expect(team.participant.some((p: any) => p.person.reference === `Person/${mia.person.id}` && p.status === "active")).toBe(true);
  });
  it("by email: same answer for a known and an unknown address; no email in any record; matched when they sign in", async () => {
    const { call, s, ana, mia, T, mail } = await net();
    const known = await call("/$invite", { target: { reference: `Team/${T}` }, email: "Mia@Example.org" }, ana.token);
    const unknown = await call("/$invite", { target: { reference: `Team/${T}` }, email: "nobody@example.org" }, ana.token);
    expect(known).toEqual(unknown);
    expect(mail.map((m) => m.to)).toEqual(["mia@example.org", "nobody@example.org"]);
    expect(mail[0]!.text).not.toMatch(/Water/); // no detail beyond the group and who invited
    const invs = await s.store.search!("Invitation", {});
    expect(JSON.stringify(invs)).not.toMatch(/example\.org/i);
    const list = (await call("/$invitations", undefined, mia.token)).json.entry;
    expect(list).toHaveLength(1);
  });
  it("block stops further invitations from that group, silently", async () => {
    const { call, ana, mia, T, O } = await net();
    await call("/$me/handle", { value: "mia.cebu" }, mia.token);
    await call("/$invite", { target: { reference: `Team/${T}` }, handle: "mia.cebu" }, ana.token);
    const [inv] = (await call("/$invitations", undefined, mia.token)).json.entry;
    await call(`/$invitations/${inv.id}`, { answer: "block" }, mia.token);
    expect((await call("/$invite", { target: { reference: `Organization/${O}` }, handle: "mia.cebu" }, ana.token)).json.sent).toBe(true);
    expect((await call("/$invitations", undefined, mia.token)).json.entry).toHaveLength(0);
  });
  it("can't be created or edited through a plain bundle", async () => {
    const { tx, call, ana, mia, T } = await net();
    const r = await tx(ana.token, { resourceType: "Invitation", id: crypto.randomUUID(), meta: { version: 1 }, target: { reference: `Team/${T}` }, invitedBy: { reference: `Person/${ana.person.id}` }, invitee: { reference: `Person/${mia.person.id}` }, role: "team-member", status: "sent", via: "in-app" });
    expect(r.status).toBe(409);
    await call("/$me/handle", { value: "mia.cebu" }, mia.token);
    await call("/$invite", { target: { reference: `Team/${T}` }, handle: "mia.cebu" }, ana.token);
    const [inv] = (await call("/$invitations", undefined, mia.token)).json.entry;
    const rec = (await call(`/Invitation/${inv.id}`, undefined, ana.token)).json;
    expect((await tx(ana.token, { ...rec, meta: { version: rec.meta.version + 1 }, status: "accepted" })).status).toBe(409);
  });
});

describe("asking to do a task", () => {
  it("a volunteer adds only themselves as requested on a lead's-call task, and can cancel", async () => {
    const { tx, call, ana, vic, T, O } = await net();
    const I = crypto.randomUUID(), K = crypto.randomUUID();
    await tx(ana.token, { resourceType: "Initiative", id: I, meta: { version: 1 }, title: "Run", kind: "project", status: "active", organization: { reference: `Organization/${O}` } });
    await tx(ana.token, { resourceType: "Task", id: K, meta: { version: 1 }, intent: "plan", status: "ready", title: "Buy water", partOf: { reference: `Initiative/${I}` }, owner: { reference: `Team/${T}` }, team: { reference: `Team/${T}` }, audience: "organization", taking: "ask" });
    const t = (await call(`/Task/${K}`, undefined, vic.token)).json;
    const me = { reference: `Person/${vic.person.id}` };
    expect((await tx(vic.token, { ...t, meta: { version: 2 }, status: "accepted", owner: me })).status).toBe(409);
    expect((await tx(vic.token, { ...t, meta: { version: 2 }, participant: [{ person: me, role: "owner", status: "requested" }] })).status).toBe(200);
    const t2 = (await call(`/Task/${K}`, undefined, vic.token)).json;
    expect((await tx(vic.token, { ...t2, meta: { version: 3 }, participant: [] })).status).toBe(200);
  });
});
