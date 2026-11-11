import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

describe("on React Native's fetch (whatwg-fetch), as on the phone", () => {
  it("runs pairing, a commit, a file upload and download through app.fetch", async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { Request: g.Request, Response: g.Response, Headers: g.Headers, fetch: g.fetch };
    delete g.Request; delete g.Response; delete g.Headers; delete g.fetch;
    createRequire(import.meta.url)("whatwg-fetch/dist/fetch.umd.js");
    try {
      const { createApp, sqliteStore, hashToken } = await import("../src/index.js");
      const { nodeDb } = await import("./node-db.js");
      const s = await sqliteStore(nodeDb());
      const app = createApp({ cors: false, store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, files: s.files, devices: s.devices, pairingCode: () => "C",
        async identify(req) { const h = req.headers.get("authorization"); return { person: h ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
        now: () => new Date().toISOString(), newId: () => crypto.randomUUID() });
      const R = g.Request as typeof Request;
      const res = await app.fetch(new R("http://phone/$pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "C", nickname: "Don" }) }));
      const me = await res.json();
      expect(me.person.name.text).toBe("Don");
      const auth = { authorization: `Bearer ${me.token}` };
      const org = { resourceType: "Organization", id: crypto.randomUUID(), meta: { version: 1 }, name: "Kabataan Tutors", kind: "informal" };
      const c = await app.fetch(new R("http://phone/", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ type: "transaction", entry: [{ resource: org }] }) }));
      expect(c.status).toBe(200);
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      const up = await (await app.fetch(new R("http://phone/$files?title=x", { method: "POST", headers: { ...auth, "content-type": "image/png" }, body: bytes }))).json();
      expect(up.size).toBe(5);
      const back = new Uint8Array(await (await app.fetch(new R("http://phone" + up.url, { headers: auth }))).arrayBuffer());
      expect([...back]).toEqual([1, 2, 3, 4, 5]);
    } finally { Object.assign(g, saved); }
  });
});
