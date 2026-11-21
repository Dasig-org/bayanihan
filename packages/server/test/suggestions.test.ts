import { describe, expect, it } from "vitest";
import { createApp, hashToken, sqliteStore } from "../src/index.js";
import { declineSuggestion } from "@bayanihan/core";
import { nodeDb } from "./node-db.js";

/** BIX "Suggestions and their answers" on the server (2026-11-14). */
describe("suggestions and their answers", () => {
  it("records the model on an accepted suggestion, saves Not this time, and counts both", async () => {
    const s = await sqliteStore(nodeDb());
    const app = createApp({ store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files, openJoin: { audience: "https://x", perHour: 50 },
      async identify(req) { const h = req.headers.get("authorization"); return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
      now: () => new Date().toISOString(), newId: () => crypto.randomUUID() });
    const call = async (path: string, body?: unknown, tok?: string) => { const r = await app.request(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: (await r.json().catch(() => ({}))) as any }; };
    const ana = (await call("/$join", { nickname: "Ana" })).json;
    const O = crypto.randomUUID(), I = crypto.randomUUID();
    const tx = (entry: unknown[]) => call("/", { resourceType: "Bundle", type: "transaction", entry }, ana.token);
    await tx([{ resource: { resourceType: "Organization", id: O, meta: { version: 1 }, name: "Club" } }]);
    await tx([{ resource: { resourceType: "Initiative", id: I, meta: { version: 1 }, title: "Run", kind: "project", status: "active", organization: { reference: `Organization/${O}` } } }]);
    const r = await tx([{ resource: { resourceType: "Task", id: crypto.randomUUID(), meta: { version: 1 }, intent: "plan", status: "ready", title: "Get the permit", partOf: { reference: `Initiative/${I}` }, owner: { reference: `Person/${ana.person.id}` } },
      assistedBy: { type: "model", model: { name: "Bayani-1-1B", version: "1", question: "applies", confidence: 0.9 } } }]);
    expect(r.status).toBe(200);
    const d = await tx([{ resource: declineSuggestion({ id: crypto.randomUUID(), target: { reference: `Initiative/${I}` }, basedOn: 1, organization: { reference: `Organization/${O}` }, question: "applies", title: "Print bibs" }) }]);
    if (d.status !== 200) console.log("D", JSON.stringify(d.json).slice(0, 500)); expect(d.status).toBe(200);
    const m = await call(`/Organization/${O}/$suggestions`, undefined, ana.token);
    expect(m.json.byQuestion.applies).toEqual({ used: 1, edited: 0, declined: 1 });
    // A model's own idea for a step (2026-11-21): no confidence, counted under its own question.
    const idea = await tx([{ resource: { resourceType: "Task", id: crypto.randomUUID(), meta: { version: 1 }, intent: "plan", status: "ready", title: "Set up a first aid tent", partOf: { reference: `Initiative/${I}` } },
      assistedBy: { type: "model", model: { name: "Bayani-1", version: "1", question: "step-ideas" } } }]);
    expect(idea.status).toBe(200);
    expect((await call(`/Organization/${O}/$suggestions`, undefined, ana.token)).json.byQuestion["step-ideas"]).toEqual({ used: 1, edited: 0, declined: 0 });
  });

  it("lets a lead keep a step for next time as the group's own Practice (close-out), linked, suggested by Bayani; never with figures", async () => {
    const s = await sqliteStore(nodeDb());
    const app = createApp({ store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files, openJoin: { audience: "https://x", perHour: 50 },
      async identify(req) { const h = req.headers.get("authorization"); return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
      now: () => new Date().toISOString(), newId: () => crypto.randomUUID() });
    const call = async (path: string, body?: unknown, tok?: string) => { const r = await app.request(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: (await r.json().catch(() => ({}))) as any }; };
    const ana = (await call("/$join", { nickname: "Ana" })).json, ben = (await call("/$join", { nickname: "Ben" })).json;
    const O = crypto.randomUUID(), I = crypto.randomUUID(), T = crypto.randomUUID();
    const tx = (entry: unknown[], tok = ana.token) => call("/", { resourceType: "Bundle", type: "transaction", entry }, tok);
    await tx([{ resource: { resourceType: "Organization", id: O, meta: { version: 1 }, name: "Club" } }]);
    await tx([{ resource: { resourceType: "Initiative", id: I, meta: { version: 1 }, title: "Run", kind: "project", status: "active", organization: { reference: `Organization/${O}` } } }]);
    const task = { resourceType: "Task", id: T, meta: { version: 1 }, intent: "plan", status: "ready", title: "Book the Lahug covered court", partOf: { reference: `Initiative/${I}` }, owner: { reference: `Person/${ana.person.id}` } };
    expect((await tx([{ resource: task }])).status).toBe(200);
    const P = crypto.randomUUID();
    const practice = { resourceType: "Practice", id: P, meta: { version: 1 }, title: "Book the venue", organization: { reference: `Organization/${O}` }, status: "active", source: "own", appliesTo: [{ system: "bayanihan:initiative-category", code: "fun-run" }] };
    const by = { type: "model", model: { name: "Bayani-1", version: "1", question: "general-title" } };
    // Someone outside the group can't; figures can't be set.
    expect((await tx([{ resource: { ...practice, id: crypto.randomUUID() } }], ben.token)).status).not.toBe(200);
    expect((await tx([{ resource: { ...practice, id: crypto.randomUUID(), observed: { included: 3, ofProjects: 3 } } }])).status).not.toBe(200);
    const r = await tx([{ resource: practice, assistedBy: by }, { resource: { ...task, meta: { version: 2 }, practice: { reference: `Practice/${P}` } }, assistedBy: by }]);
    if (r.status !== 200) console.log(JSON.stringify(r.json).slice(0, 400));
    expect(r.status).toBe(200);
    expect((await call(`/Task/${T}`, undefined, ana.token)).json.practice.reference).toBe(`Practice/${P}`);
  });
});
