import { describe, expect, it } from "vitest";
import { generatePersonKey, keyIdFor, signChallenge } from "@bayanihan/core";
import { createApp, sqliteStore, hashToken } from "../src/index.js";
import { nodeDb } from "./node-db.js";

const AUD = "https://ecosystem.test";
async function hosted(maxAgeMs?: number) {
  const s = await sqliteStore(nodeDb());
  let now = Date.now();
  const app = createApp({ store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files, openJoin: { audience: AUD, perHour: 100 },
    google: { identities: s.identities, async verify(t) { return t.startsWith("google:") ? { sub: t.slice(7), email: "don@example.com" } : null; } },
    async identify(req) { const h = req.headers.get("authorization"); return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7)), maxAgeMs) : null }; },
    now: () => new Date(now).toISOString(), newId: () => crypto.randomUUID() });
  const call = (path: string, body?: unknown, token?: string) => app.request(path, { method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { call, s };
}
async function phone() {
  const k = await generatePersonKey();
  const person = { resourceType: "Person", id: crypto.randomUUID(), meta: { version: 1 }, name: { text: "Don", use: "nickname" }, publicKey: [{ kid: keyIdFor(k.publicKey), alg: "Ed25519", key: k.publicKey, status: "active" }] };
  return { k, person };
}
const proof = async (call: (p: string) => Response | Promise<Response>, ph: { k: { privateKey: string }; person: { id: string } }) => {
  const { challenge } = await (await call("/$challenge")).json();
  return { challenge, proof: signChallenge(challenge, `Person/${ph.person.id}`, AUD, ph.k.privateKey) };
};

describe("getting back in with Google", () => {
  it("links Google to a person, and after the app is deleted, brings the same person back with the new phone's key", async () => {
    const { call } = await hosted();
    const old = await phone();
    const joined = await (await call("/$join", { person: old.person, ...(await proof(call, old)) })).json();
    const link = await (await call("/$google", { idToken: "google:abc" }, joined.token)).json();
    expect(link.person.id).toBe(old.person.id);
    // The app is deleted: a fresh phone has a new Person and key. Google brings back the old person; the new key joins it.
    const fresh = await phone();
    const back = await (await call("/$google", { idToken: "google:abc", person: fresh.person, ...(await proof(call, fresh)) })).json();
    expect(back.person.id).toBe(old.person.id);
    expect(back.person.publicKey.map((x: any) => x.key)).toEqual([old.person.publicKey[0]!.key, fresh.person.publicKey[0]!.key]);
    const me = await (await call("/$me", {}, back.token)).json();
    expect(me.id).toBe(old.person.id);
    // With the key now on the person, the new phone can renew its token by itself.
    const renewed = await call("/$join", { person: { ...fresh.person, id: old.person.id }, ...(await (async () => { const { challenge } = await (await call("/$challenge")).json(); return { challenge, proof: signChallenge(challenge, `Person/${old.person.id}`, AUD, fresh.k.privateKey) }; })()) });
    expect(renewed.status).toBe(201);
  });
  it("refuses a Google token it can't verify", async () => {
    const { call } = await hosted();
    expect((await call("/$google", { idToken: "forged" })).status).toBe(401);
  });
  it("stops accepting a phone token after its age limit", async () => {
    const { call } = await hosted(1);
    const j = await (await call("/$join", { nickname: "Ana" })).json();
    await new Promise((r) => setTimeout(r, 15));
    expect((await call("/$me", {}, j.token)).status).toBe(401);
  });
});
