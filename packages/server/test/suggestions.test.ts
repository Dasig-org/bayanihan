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
  });
});
