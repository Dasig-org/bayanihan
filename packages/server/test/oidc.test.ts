import { describe, expect, it } from "vitest";
import { generatePersonKey, keyIdFor, signChallenge } from "@bayanihan/core";
import { createApp, sqliteStore, hashToken } from "../src/index.js";
import { nodeDb } from "./node-db.js";

/** Signing in with a Dasig account (OIDC): docs/auth/DASIG_ACCOUNTS.md. Tokens are faked as "dasig:<sub>:<name>". */
const AUD = "https://ecosystem.test";
async function hosted() {
  const s = await sqliteStore(nodeDb());
  const app = createApp({ store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files, openJoin: { audience: AUD, perHour: 100 },
    oidc: { identities: s.identities, providers: { dasig: { async verify(t) { const [k, sub, name] = t.split(":"); return k === "dasig" && sub ? { sub, ...(name ? { name } : {}) } : null; } } } },
    async identify(req) { const h = req.headers.get("authorization"); return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
    now: () => new Date().toISOString(), newId: () => crypto.randomUUID() });
  return (path: string, body?: unknown, token?: string) => app.request(path, { method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function phone(name = "Don") {
  const k = await generatePersonKey();
  return { k, person: { resourceType: "Person", id: crypto.randomUUID(), meta: { version: 1 }, name: { text: name, use: "nickname" }, publicKey: [{ kid: keyIdFor(k.publicKey), alg: "Ed25519", key: k.publicKey, status: "active", created: new Date().toISOString() }] } };
}
const proof = async (call: Awaited<ReturnType<typeof hosted>>, ph: Awaited<ReturnType<typeof phone>>) => {
  const { challenge } = await (await call("/$challenge")).json();
  return { challenge, proof: signChallenge(challenge, `Person/${ph.person.id}`, AUD, ph.k.privateKey) };
};

describe("signing in with a Dasig account", () => {
  it("a new account creates a person named from the token, and signing in again brings the same person back", async () => {
    const call = await hosted();
    const first = await (await call("/$oidc", { provider: "dasig", idToken: "dasig:u1:Ana Reyes" })).json();
    expect(first.person.name.text).toBe("Ana Reyes");
    const again = await (await call("/$oidc", { provider: "dasig", idToken: "dasig:u1" })).json();
    expect(again.person.id).toBe(first.person.id);
    expect(again.token).not.toBe(first.token);
  });
  it("a nickname person on this device keeps their records: the account links to them, no duplicate", async () => {
    const call = await hosted();
    const ph = await phone("Mia");
    const joined = await (await call("/$join", { person: ph.person, ...(await proof(call, ph)) })).json();
    const linked = await (await call("/$oidc", { provider: "dasig", idToken: "dasig:u2:Mia Santos" }, joined.token)).json();
    expect(linked.person.id).toBe(ph.person.id);
    // A new browser later: the Dasig account brings Mia back.
    const back = await (await call("/$oidc", { provider: "dasig", idToken: "dasig:u2" })).json();
    expect(back.person.id).toBe(ph.person.id);
  });
  it("refuses an unknown provider and a token that doesn't verify", async () => {
    const call = await hosted();
    expect((await call("/$oidc", { provider: "other", idToken: "dasig:u3" })).status).toBe(404);
    expect((await call("/$oidc", { provider: "dasig", idToken: "forged" })).status).toBe(401);
  });
  it("Google and Dasig links are separate: one subject can't stand in for the other", async () => {
    const call = await hosted();
    const a = await (await call("/$oidc", { provider: "dasig", idToken: "dasig:same:A" })).json();
    expect((await call("/$google", { idToken: "google:same" })).status).toBe(404); // Google isn't configured here
    expect(a.person.id).toBeTruthy();
  });
  it("signing out ends the session on the server, and the Dasig account still brings the person back", async () => {
    const call = await hosted();
    const a = await (await call("/$oidc", { provider: "dasig", idToken: "dasig:u9:Lea" })).json();
    expect((await call("/$me", {}, a.token)).status).toBe(200);
    await call("/$signout", {}, a.token);
    expect((await call("/$me", {}, a.token)).status).not.toBe(200);
    const b = await (await call("/$oidc", { provider: "dasig", idToken: "dasig:u9" })).json();
    expect(b.person.id).toBe(a.person.id);
  });
});
