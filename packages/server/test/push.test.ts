import { describe, expect, it } from "vitest";
import { createApp, hashToken, pushesFor, sqliteStore, type PushMessage, type PushTarget } from "../src/index.js";
import { nodeDb } from "./node-db.js";

const AUD = "https://ecosystem.dasig.org";
async function hosted() {
  const s = await sqliteStore(nodeDb());
  const sent: { to: PushTarget[]; m: PushMessage }[] = [];
  const gone = new Set<string>();
  const send = async (to: PushTarget[], m: PushMessage) => { sent.push({ to, m }); return to.filter((t) => gone.has(t.target)).map((t) => t.target); };
  const app = createApp({
    store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files,
    openJoin: { audience: AUD, perHour: 50 }, push: { targets: s.pushTargets, send: { expo: send, web: send }, webPublicKey: "BPUB" },
    async identify(req) { const h = req.headers.get("authorization"); return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
    now: () => new Date().toISOString(), newId: () => crypto.randomUUID(),
  });
  const call = (path: string, body?: unknown, token?: string) => app.request(path, { method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `9.9.${Math.floor(Math.random() * 250)}.1`, ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const join = async (nickname: string) => (await (await call("/$join", { nickname })).json()) as { token: string; person: { id: string } };
  const commit = (token: string, ...rs: unknown[]) => call("/", { resourceType: "Bundle", type: "transaction", entry: rs.map((resource) => ({ resource: { meta: { version: 1 }, ...(resource as object) } })) }, token);
  return { s, call, join, commit, sent, gone };
}
const settle = () => new Promise((r) => setTimeout(r, 60));
const expoTok = (n: string) => `ExponentPushToken[abcdefgh${n}]`;

describe("push notifications", () => {
  it("says what it can send, and only takes valid targets", async () => {
    const { call, join } = await hosted();
    expect(await (await call("/$push")).json()).toEqual({ web: "BPUB", expo: true });
    const a = await join("Ana");
    expect((await call("/$push", { kind: "expo", target: expoTok("1") })).status).toBe(401);
    expect((await call("/$push", { kind: "expo", target: "not-a-token" }, a.token)).status).toBe(400);
    expect((await call("/$push", { kind: "web", target: { endpoint: "http://insecure" } }, a.token)).status).toBe(400);
    expect((await call("/$push", { kind: "web", target: { endpoint: "https://push.example/x", keys: { p256dh: "k", auth: "a" } } }, a.token)).status).toBe(200);
  });

  it("tells the person asked, and never the one who asked; sign-out stops it", async () => {
    const { s, call, join, commit, sent } = await hosted();
    const ana = await join("Ana"); const ben = await join("Ben");
    await call("/$push", { kind: "expo", target: expoTok("ben") }, ben.token);
    await call("/$push", { kind: "expo", target: expoTok("ana") }, ana.token);
    const org = { resourceType: "Organization", id: crypto.randomUUID(), name: "Humans of Cebu" };
    expect((await commit(ana.token, org)).status).toBe(200);
    const ini = { resourceType: "Initiative", id: crypto.randomUUID(), title: "Fun Run", kind: "project", status: "active", organization: { reference: `Organization/${org.id}` } };
    expect((await commit(ana.token, ini)).status).toBe(200);
    const task = { resourceType: "Task", id: crypto.randomUUID(), intent: "plan", status: "requested", title: "Buy water for the kids at Tondo", partOf: { reference: `Initiative/${ini.id}` }, owner: { reference: `Person/${ben.person.id}` } };
    expect((await commit(ana.token, task)).status).toBe(200);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.map((t) => t.target)).toEqual([expoTok("ben")]);
    expect(sent[0]!.m.title).toBe("Humans of Cebu asked you to help");
    expect(JSON.stringify(sent[0]!.m)).not.toContain("Tondo"); // task text never leaves in a push
    await call("/$signout", {}, ben.token);
    expect(await s.pushTargets.forPerson(`Person/${ben.person.id}`)).toEqual([]);
  });

  it("tells officers when someone asks to join, and drops targets that are gone", async () => {
    const { s, call, join, commit, sent, gone } = await hosted();
    const ana = await join("Ana"); const cy = await join("Cy");
    await call("/$push", { kind: "expo", target: expoTok("ana") }, ana.token);
    const org = { resourceType: "Organization", id: crypto.randomUUID(), name: "Lahug Runners" };
    await commit(ana.token, org);
    gone.add(expoTok("ana"));
    const r = await commit(cy.token, { resourceType: "Role", id: crypto.randomUUID(), status: "requested", person: { reference: `Person/${cy.person.id}` }, organization: { reference: `Organization/${org.id}` }, code: { system: "bayanihan:role", code: "volunteer-episodic" } });
    expect(r.status).toBe(200);
    await settle();
    expect(sent.at(-1)!.m.title).toBe("Someone wants to join Lahug Runners");
    expect(await s.pushTargets.forPerson(`Person/${ana.person.id}`)).toEqual([]);
  });

  it("does not repeat an ask that is only edited", async () => {
    const t = { resourceType: "Task", id: "t1", status: "requested", owner: { reference: "Person/b" }, partOf: { reference: "Initiative/i" } };
    const get = async () => null; const search = async () => [];
    expect(await pushesFor(t, { ...t, title: "renamed" }, "Person/a", get, search)).toEqual([]);
    expect(await pushesFor(null, t, "Person/a", get, search)).toHaveLength(1);
    expect(await pushesFor(null, t, "Person/b", get, search)).toEqual([]);
  });
});
