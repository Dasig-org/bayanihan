import { describe, expect, it } from "vitest";
import { createApp, hashToken, sqliteStore } from "../src/index.js";
import { nodeDb } from "./node-db.js";

/** Joining a team (teamwork sketches B): ask, cancel, leave, and nothing else; core members add themselves directly. */
async function club() {
  const s = await sqliteStore(nodeDb());
  const app = createApp({ store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files, openJoin: { audience: "https://x", perHour: 50 },
    async identify(req) { const h = req.headers.get("authorization"); return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
    now: () => new Date().toISOString(), newId: () => crypto.randomUUID() });
  let ip = 0;
  const call = async (path: string, body?: unknown, tok?: string) => { const r = await app.request(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-forwarded-for": `10.1.${++ip}.1`, ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: (await r.json().catch(() => ({}))) as any }; };
  const join = async (n: string) => (await call("/$join", { nickname: n })).json as { token: string; person: { id: string } };
  const tx = async (tok: string, ...rs: any[]) => (await call("/", { resourceType: "Bundle", type: "transaction", entry: rs.map((resource) => ({ resource })) }, tok));
  const ana = await join("Ana"), don = await join("Don"), mia = await join("Mia"), out = await join("Out");
  const O = crypto.randomUUID(), T = crypto.randomUUID();
  await tx(ana.token, { resourceType: "Organization", id: O, meta: { version: 1 }, name: "Club" });
  const role = (p: { person: { id: string } }, code: string) => ({ resourceType: "Role", id: crypto.randomUUID(), meta: { version: 1 }, status: "active", person: { reference: `Person/${p.person.id}` }, organization: { reference: `Organization/${O}` }, code: { system: "bayanihan:role", code } });
  await tx(ana.token, role(don, "core-member"), role(mia, "volunteer-regular"));
  const lead = { person: { reference: `Person/${ana.person.id}` }, role: "lead", status: "active" };
  const r = await tx(ana.token, { resourceType: "Team", id: T, meta: { version: 1 }, name: "Comms", organization: { reference: `Organization/${O}` }, kind: "standing", status: "active", participant: [lead] });
  expect(r.status).toBe(200);
  const team = async (tok = ana.token) => (await call(`/Team/${T}`, undefined, tok)).json;
  const change = async (tok: string, f: (t: any) => any) => { const t = await team(); return tx(tok, { ...f(t), meta: { version: t.meta.version + 1 } }); };
  return { ana, don, mia, out, change, team, lead };
}

describe("joining a team", () => {
  it("a volunteer asks, cancels, asks again; can't make themselves a member or lead, or touch others", async () => {
    const { mia, change } = await club();
    const me = { reference: `Person/${mia.person.id}` };
    expect((await change(mia.token, (t) => ({ ...t, participant: [...t.participant, { person: me, role: "volunteer", status: "active" }] }))).status).toBe(409);
    expect((await change(mia.token, (t) => ({ ...t, participant: [...t.participant, { person: me, role: "lead", status: "requested" }] }))).status).toBe(409);
    expect((await change(mia.token, (t) => ({ ...t, participant: [...t.participant, { person: me, role: "volunteer", status: "requested" }] }))).status).toBe(200);
    expect((await change(mia.token, (t) => ({ ...t, name: "Mine" }))).status).toBe(409);
    expect((await change(mia.token, (t) => ({ ...t, participant: t.participant.filter((p: any) => p.person.reference !== me.reference) }))).status).toBe(200);
    expect((await change(mia.token, (t) => ({ ...t, participant: [] }))).status).toBe(409); // can't remove the lead
  });
  it("someone outside the group can't ask; a core member joins directly", async () => {
    const { out, don, change } = await club();
    expect((await change(out.token, (t) => ({ ...t, participant: [...t.participant, { person: { reference: `Person/${out.person.id}` }, role: "volunteer", status: "requested" }] }))).status).toBe(409);
    expect((await change(don.token, (t) => ({ ...t, participant: [...t.participant, { person: { reference: `Person/${don.person.id}` }, role: "member", status: "active" }] }))).status).toBe(200);
  });
});
