import { describe, expect, it } from "vitest";
import net from "node:net";
import { serveTcp, type CreateServer } from "../src/http-tcp.js";
import { createApp, sqliteStore, memoryFiles, hashToken } from "../src/index.js";
import { nodeDb } from "./node-db.js";

describe("HTTP over TCP (the hub's network layer)", () => {
  it("serves the BIX API to another device over a socket: pair, read, upload, download", async () => {
    const s = await sqliteStore(nodeDb());
    const app = createApp({ store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files, pairingCode: () => "QR-1",
      async identify(req) { const h = req.headers.get("authorization"); return { person: h ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
      now: () => new Date().toISOString(), newId: () => crypto.randomUUID() });
    const port = 18787;
    const server = serveTcp(net.createServer as unknown as CreateServer, app.fetch, { port, host: "127.0.0.1", origin: () => `http://127.0.0.1:${port}` });
    await new Promise((r) => setTimeout(r, 100));
    const base = `http://127.0.0.1:${port}`;
    const meta = await (await fetch(base + "/metadata")).json();
    expect(meta.software.name).toBe("Bayanihan Server");
    const paired = await (await fetch(base + "/$pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "QR-1", nickname: "Liza" }) })).json();
    expect(paired.person.name.text).toBe("Liza");
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    const up = await (await fetch(base + "/$files?title=photo", { method: "POST", headers: { "content-type": "image/png", authorization: `Bearer ${paired.token}` }, body: bytes })).json();
    const back = new Uint8Array(await (await fetch(base + up.url, { headers: { authorization: `Bearer ${paired.token}` } })).arrayBuffer());
    expect(back.length).toBe(bytes.length);
    expect(back[12345]).toBe(bytes[12345]);
    (server as net.Server).close();
  });
});
