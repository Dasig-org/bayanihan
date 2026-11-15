import { describe, expect, it } from "vitest";
import { createApp, hashToken, sqliteStore } from "../src/index.js";
import { nodeDb } from "./node-db.js";

/** BIX "Who may change what on a Task": the owner may add subtasks under it (partOf); asking someone else needs task.assign. */
describe("subtasks", () => {
  it("the owner adds a subtask for themselves or open to the team; can't ask someone else; others can only propose", async () => {
    const s = await sqliteStore(nodeDb());
    const app = createApp({ store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files, openJoin: { audience: "https://x", perHour: 50 },
      async identify(req) { const h = req.headers.get("authorization"); return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
      now: () => new Date().toISOString(), newId: () => crypto.randomUUID() });
    let ip = 0;
    const call = async (path: string, body?: unknown, tok?: string) => { const r = await app.request(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-forwarded-for": `10.2.${++ip}.1`, ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: (await r.json().catch(() => ({}))) as any }; };
    const join = async (n: string) => (await call("/$join", { nickname: n })).json as { token: string; person: { id: string } };
    const tx = async (tok: string, ...rs: any[]) => call("/", { resourceType: "Bundle", type: "transaction", entry: rs.map((resource) => ({ resource })) }, tok);
    const ana = await join("Ana"), mia = await join("Mia"), ben = await join("Ben");
    const O = crypto.randomUUID(), I = crypto.randomUUID(), T = crypto.randomUUID(), P = crypto.randomUUID();
    const org = { reference: `Organization/${O}` };
    await tx(ana.token, { resourceType: "Organization", id: O, meta: { version: 1 }, name: "Club" });
    const role = (p: { person: { id: string } }, code: string) => ({ resourceType: "Role", id: crypto.randomUUID(), meta: { version: 1 }, status: "active", person: { reference: `Person/${p.person.id}` }, organization: org, code: { system: "bayanihan:role", code } });
    await tx(ana.token, role(mia, "volunteer-regular"), role(ben, "volunteer-regular"));
    await tx(ana.token, { resourceType: "Initiative", id: I, meta: { version: 1 }, title: "Run", kind: "project", status: "active", organization: org });
    const member = (p: { person: { id: string } }) => ({ person: { reference: `Person/${p.person.id}` }, role: "member", status: "active" });
    await tx(ana.token, { resourceType: "Team", id: T, meta: { version: 1 }, name: "Registration", organization: org, initiative: { reference: `Initiative/${I}` }, kind: "initiative", status: "active",
      participant: [{ person: { reference: `Person/${ana.person.id}` }, role: "lead", status: "active" }, member(mia), member(ben)] });
    const miaRef = { reference: `Person/${mia.person.id}` };
    const parent = { resourceType: "Task", id: P, meta: { version: 1 }, intent: "plan", status: "accepted", title: "Registration table", partOf: { reference: `Initiative/${I}` }, team: { reference: `Team/${T}` },
      owner: miaRef, participant: [{ person: miaRef, role: "owner", status: "active" }] };
    expect((await tx(ana.token, parent)).status).toBe(200);
    const sub = (f: any) => ({ resourceType: "Task", id: crypto.randomUUID(), meta: { version: 1 }, intent: "plan", title: "QR prints", partOf: { reference: `Task/${P}` }, team: { reference: `Team/${T}` }, ...f });
    // Mia owns the parent: a subtask for herself, and one open to the team.
    expect((await tx(mia.token, sub({ status: "accepted", owner: miaRef, participant: [{ person: miaRef, role: "owner", status: "active" }] }))).status).toBe(200);
    expect((await tx(mia.token, sub({ status: "ready", owner: { reference: `Team/${T}` } }))).status).toBe(200);
    // Asking Ben stays with the lead.
    expect((await tx(mia.token, sub({ status: "requested", owner: { reference: `Person/${ben.person.id}` } }))).status).not.toBe(200);
    const r2 = await tx(ana.token, sub({ status: "requested", owner: { reference: `Person/${ben.person.id}` } }));
    expect(r2.status).toBe(200);
    // Ben doesn't own the parent: he can only propose.
    expect((await tx(ben.token, sub({ status: "ready", owner: { reference: `Team/${T}` } }))).status).not.toBe(200);
    expect((await tx(ben.token, sub({ status: "draft", intent: "proposal", owner: { reference: `Team/${T}` } }))).status).toBe(200);
    const subs = (await call(`/Task?partOf=${encodeURIComponent(`Task/${P}`)}`, undefined, mia.token)).json;
    expect(subs.entry.length).toBeGreaterThanOrEqual(3);
  });
});
