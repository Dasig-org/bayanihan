import { describe, expect, it } from "vitest";
import { generatePersonKey, keyIdFor, signChallenge } from "@bayanihan/core";
import { createApp, sqliteStore, hashToken } from "../src/index.js";
import { nodeDb } from "./node-db.js";

const AUD = "https://ecosystem.dasig.org";
async function hosted(perHour = 10) {
  const s = await sqliteStore(nodeDb());
  const app = createApp({
    store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files,
    openJoin: { audience: AUD, perHour },
    async identify(req) { const h = req.headers.get("authorization"); return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
    now: () => new Date().toISOString(), newId: () => crypto.randomUUID(),
  });
  const call = (path: string, body?: unknown, token?: string, ip = "1.2.3.4") => app.request(path, { method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { call };
}
const keyed = async () => {
  const k = await generatePersonKey();
  const person = { resourceType: "Person", id: crypto.randomUUID(), meta: { version: 3 }, name: { text: "Mia", use: "nickname" }, publicKey: [{ kid: keyIdFor(k.publicKey), alg: "Ed25519", key: k.publicKey, status: "active" }] };
  return { k, person };
};

describe("open sign-up on a hosted server", () => {
  it("joins with just a nickname, and the token works", async () => {
    const { call } = await hosted();
    const r = await call("/$join", { nickname: "Ana" }); expect(r.status).toBe(201);
    const { token, person } = await r.json();
    const me = await (await call("/$me", {}, token)).json();
    expect(me.id).toBe(person.id);
  });
  it("brings a phone's own Person, but only with a fresh signed challenge for this server", async () => {
    const { call } = await hosted();
    const { k, person } = await keyed();
    expect((await call("/$join", { person })).status).toBe(403);
    const { challenge } = await (await call("/$challenge")).json();
    const wrongServer = signChallenge(challenge, `Person/${person.id}`, "https://elsewhere.example", k.privateKey);
    expect((await call("/$join", { person, challenge, proof: wrongServer })).status).toBe(403);
    const c2 = (await (await call("/$challenge")).json()).challenge;
    const proof = signChallenge(c2, `Person/${person.id}`, AUD, k.privateKey);
    const ok = await call("/$join", { person, challenge: c2, proof }); expect(ok.status).toBe(201);
    expect((await ok.json()).person.id).toBe(person.id);
    expect((await call("/$join", { person, challenge: c2, proof })).status).toBe(403); // a challenge works once
    // A second phone of the same person signs in with the key; someone who only knows the id can't.
    const c3 = (await (await call("/$challenge")).json()).challenge;
    expect((await call("/$join", { person, challenge: c3, proof: signChallenge(c3, `Person/${person.id}`, AUD, k.privateKey) })).status).toBe(201);
    const stranger = await generatePersonKey();
    const c4 = (await (await call("/$challenge")).json()).challenge;
    const forged = { ...person, publicKey: [{ kid: keyIdFor(stranger.publicKey), alg: "Ed25519", key: stranger.publicKey, status: "active" }] };
    expect((await call("/$join", { person: forged, challenge: c4, proof: signChallenge(c4, `Person/${person.id}`, AUD, stranger.privateKey) })).status).toBe(403);
  });
  it("refuses taking over a Person that has no key, and limits sign-ups per address", async () => {
    const { call } = await hosted(3);
    const first = await (await call("/$join", { nickname: "Liza" }, undefined, "9.9.9.9")).json();
    expect((await call("/$join", { person: first.person }, undefined, "9.9.9.9")).status).toBe(409);
    expect((await call("/$join", { nickname: "x" }, undefined, "9.9.9.9")).status).toBe(201);
    expect((await call("/$join", { nickname: "y" }, undefined, "9.9.9.9")).status).toBe(429);
    expect((await call("/$join", { nickname: "z" }, undefined, "8.8.8.8")).status).toBe(201);
  });
});
