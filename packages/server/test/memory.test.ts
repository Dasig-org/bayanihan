import { describe, expect, it } from "vitest";
import { createApp, hashToken, sqliteStore } from "../src/index.js";
import { nodeDb } from "./node-db.js";

/** Project memory learns (BIX rule 23; TRACKER A31): the server calculates Practice figures when a project completes. */
describe("project memory learns", () => {
  it("figures follow completed projects, a step's link recounts, kept steps get them at once; a rule records it", async () => {
    const s = await sqliteStore(nodeDb());
    const app = createApp({ store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files, openJoin: { audience: "https://x", perHour: 50 },
      async identify(req) { const h = req.headers.get("authorization"); return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
      now: () => new Date().toISOString(), newId: () => crypto.randomUUID() });
    let ip = 0;
    const call = async (path: string, body?: unknown, tok?: string) => { const r = await app.request(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-forwarded-for": `10.3.${++ip}.1`, ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: (await r.json().catch(() => ({}))) as any }; };
    const ana = (await call("/$join", { nickname: "Ana" })).json;
    const tx = async (...rs: any[]) => { const r = await call("/", { resourceType: "Bundle", type: "transaction", entry: rs.map((resource) => ({ resource })) }, ana.token); expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200); return r.json.entry.map((e: any) => e.record); };
    const get = async (t: string, id: string) => (await call(`/${t}/${id}`, undefined, ana.token)).json;
    const next = async (t: string, id: string, f: any) => { const x = await get(t, id); return tx({ ...x, ...f, meta: { version: x.meta.version + 1 } }); };
    const O = crypto.randomUUID(), org = { reference: `Organization/${O}` };
    await tx({ resourceType: "Organization", id: O, meta: { version: 1 }, name: "Runners" });
    const day = (d: number) => new Date(Date.UTC(2026, 0, 20 + d)).toISOString();
    const run = (start: string) => ({ resourceType: "Initiative", id: crypto.randomUUID(), meta: { version: 1 }, title: "Fun run", kind: "project", status: "active", organization: org, period: { start },
      category: [{ system: "bayanihan:initiative-category", code: "fun-run" }] });
    const P = crypto.randomUUID();
    await tx({ resourceType: "Practice", id: P, meta: { version: 1 }, title: "Get the barangay permit", organization: org, status: "active", source: "own", appliesTo: [{ system: "bayanihan:initiative-category", code: "fun-run" }] });
    const i1 = run(day(0)), i2 = run(day(60));
    await tx(i1, i2);
    // A permit step in the first run, done 10 days before it.
    const t1 = { resourceType: "Task", id: crypto.randomUUID(), meta: { version: 1 }, intent: "plan", status: "accepted", title: "Permit 2026", partOf: { reference: `Initiative/${i1.id}` }, owner: { reference: `Person/${ana.person.id}` },
      practice: { reference: `Practice/${P}` }, participant: [{ person: { reference: `Person/${ana.person.id}` }, role: "owner", status: "active" }], executionPeriod: { start: day(-12) } };
    await tx(t1);
    await next("Task", t1.id, { status: "completed", executionPeriod: { start: day(-12), end: day(-10) } });
    expect((await get("Practice", P)).observed?.ofProjects ?? 0).toBe(0); // no project completed yet
    await next("Initiative", i1.id, { status: "completed" });
    let o = (await get("Practice", P)).observed;
    expect(o).toMatchObject({ included: 1, ofProjects: 1, dayFromStart: { median: -10 } });
    // The second run completes without the step: in 1 of 2.
    await next("Initiative", i2.id, { status: "completed" });
    o = (await get("Practice", P)).observed;
    expect(o).toMatchObject({ included: 1, ofProjects: 2 });
    // Unlinking the step (a lead decides it wasn't the permit after all) recounts: in 0 of 2; linking it back, 1 of 2.
    await next("Task", t1.id, { practice: undefined });
    expect((await get("Practice", P)).observed).toMatchObject({ included: 0, ofProjects: 2 });
    await next("Task", t1.id, { practice: { reference: `Practice/${P}` } });
    expect((await get("Practice", P)).observed).toMatchObject({ included: 1, ofProjects: 2 });
    // A step kept at close-out (a new Practice, linked from a step of a completed project) gets its figures at once.
    const K = crypto.randomUUID();
    const t2 = { resourceType: "Task", id: crypto.randomUUID(), meta: { version: 1 }, intent: "plan", status: "ready", title: "Book a shuttle from the mall", partOf: { reference: `Initiative/${i1.id}` }, owner: org };
    await tx(t2);
    const kept = await tx({ resourceType: "Practice", id: K, meta: { version: 1 }, title: "Book a shuttle", organization: org, status: "active", source: "own", appliesTo: [{ system: "bayanihan:initiative-category", code: "fun-run" }] },
      { ...(await get("Task", t2.id)), practice: { reference: `Practice/${K}` }, meta: { version: 2 } });
    expect(kept.length).toBe(2);
    expect((await get("Practice", K)).observed).toMatchObject({ included: 1, ofProjects: 2 });
    // Recorded as a rule, never as a person.
    const hist = (await call(`/Practice/${P}/$provenance`, undefined, ana.token)).json.entry;
    expect(hist.some((e: any) => e.rule)).toBe(true);
    // Officers can recalculate on demand (nothing changes now).
    expect((await call(`/Organization/${O}/$recalculate`, {}, ana.token)).json).toEqual({ changed: 0 });
  });
});
