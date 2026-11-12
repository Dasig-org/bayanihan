import { describe, expect, it } from "vitest";
import { createApp, hashToken, sqliteStore } from "../src/index.js";
import { nodeDb } from "./node-db.js";

async function hosted() {
  const s = await sqliteStore(nodeDb());
  const mail: { to: string; code: string }[] = [];
  const google = { verify: async (t: string) => (t.startsWith("g:") ? { sub: t.slice(2), email: `${t.slice(2)}@gmail.com` } : null), identities: s.identities };
  const app = createApp({
    store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, devices: s.devices, files: s.files,
    openJoin: { audience: "https://ecosystem.dasig.org", perHour: 50 }, google,
    email: { identities: s.identities, codes: s.emailCodes, send: async (to, code) => { mail.push({ to, code }); } },
    async identify(req) { const h = req.headers.get("authorization"); return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7))) : null }; },
    now: () => new Date().toISOString(), newId: () => crypto.randomUUID(),
  });
  let ip = 0;
  const call = async (path: string, body?: unknown, token?: string, ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36") => {
    const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "user-agent": ua, "x-forwarded-for": `10.0.${++ip % 250}.1`, ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const byEmail = async (email: string, extra: Record<string, unknown> = {}, token?: string) => {
    expect((await call("/$email/start", { email })).status).toBe(200);
    return call("/$email/verify", { email, code: mail.at(-1)!.code, ...extra }, token);
  };
  return { s, call, mail, byEmail };
}

describe("email code sign-in", () => {
  it("makes an account the first time and signs back in to it after", async () => {
    const { byEmail } = await hosted();
    const first = await byEmail("Don@Example.org");
    expect(first.status).toBe(200);
    const again = await byEmail("don@example.org");
    expect(again.json.person.id).toBe(first.json.person.id);
    expect(again.json.via).toBe("email");
  });
  it("refuses a wrong code, and a code after five wrong tries", async () => {
    const { call, mail } = await hosted();
    await call("/$email/start", { email: "a@b.org" });
    const right = mail.at(-1)!.code, wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await call("/$email/verify", { email: "a@b.org", code: wrong })).status).toBe(401);
    expect((await call("/$email/verify", { email: "a@b.org", code: right })).status).toBe(401);
    expect((await call("/$email/start", { email: "a@b.org" })).status).toBe(429); // just sent
    expect((await call("/$email/start", { email: "not-an-email" })).status).toBe(400);
  });
});

describe("ways to sign in and devices", () => {
  it("lists methods with their email, adds one only while signed in, and never takes another's", async () => {
    const { call, byEmail } = await hosted();
    const don = (await call("/$google", { idToken: "g:don", deviceName: "Android phone" })).json;
    expect((await call("/$google", { idToken: "g:mia", link: true })).status).toBe(401);
    const linked = await byEmail("don@example.org", { link: true }, don.token);
    expect(linked.json.linked).toBe(true);
    const acct = (await call("/$me/account", undefined, don.token)).json;
    expect(acct.methods.map((m: any) => [m.provider, m.email])).toEqual([["google", "don@gmail.com"], ["email", "don@example.org"]]);
    expect(acct.via).toBe("google");
    expect(acct.devices[0]).toMatchObject({ name: "Android phone", via: "google", current: true });
    const mia = (await call("/$google", { idToken: "g:mia" })).json;
    expect((await call("/$google", { idToken: "g:don", link: true }, mia.token)).status).toBe(409);
  });
  it("won't remove the last method or the one this phone signed in with", async () => {
    const { call, byEmail } = await hosted();
    const don = (await call("/$google", { idToken: "g:don" })).json;
    expect((await call("/$me/account/remove", { provider: "google" }, don.token)).status).toBe(409); // the only one
    await byEmail("don@example.org", { link: true }, don.token);
    expect((await call("/$me/account/remove", { provider: "google" }, don.token)).status).toBe(409); // this phone's
    expect((await call("/$me/account/remove", { provider: "email" }, don.token)).json.removed).toBe(1);
  });
  it("signs another phone out remotely, but not this one", async () => {
    const { call } = await hosted();
    const phone = (await call("/$google", { idToken: "g:don", deviceName: "Android phone" })).json;
    const laptop = (await call("/$google", { idToken: "g:don" })).json;
    const acct = (await call("/$me/account", undefined, phone.token)).json;
    const other = acct.devices.find((d: any) => !d.current);
    expect(other.name).toBe("Chrome on a Mac");
    const here = acct.devices.find((d: any) => d.current);
    expect((await call("/$me/account/remove", { device: here.id }, phone.token)).status).toBe(409);
    expect((await call("/$me/account/remove", { device: other.id }, phone.token)).json.removed).toBe(1);
    expect((await call("/$me/account", undefined, laptop.token)).status).toBe(401);
  });
});
