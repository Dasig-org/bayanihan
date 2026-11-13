import { applyChange, type BixResource } from "@bayanihan/core";
import type { Hono } from "hono";

/*
 * Usernames and invitations (BIX "Usernames and invitations", 2026-11-13; scope in workspace/docs/accounts/
 * USERNAMES_AND_INVITES.md). The routes:
 *   POST /$me/handle {value | null}     claim, change or drop your username
 *   GET  /$handle/:value                exact lookup: nickname and photo only, if findable
 *   POST /$invite {target, role, handle | email | person, message?}
 *   GET  /$invitations                  invitations to me (claims any sent to my verified emails)
 *   POST /$invitations/:id {answer: accept | decline | block | withdraw}
 * Privacy (MUST): an email is kept only as a salted hash beside the invitation, never in a record or a response, and
 * inviting by email answers the same whether or not anyone uses that address. Lookups are exact and rate-limited.
 */
export type InviteStore = {
  handleOwner(value: string): Promise<{ person: string; releasedAt: string | null } | null>;
  setHandle(value: string, person: string): Promise<void>;
  releaseHandle(value: string, at: string): Promise<void>;
  saveEmail(invitation: string, hash: string): Promise<void>;
  invitationsForHashes(hashes: string[]): Promise<string[]>;
  forgetEmail(invitation: string): Promise<void>;
  block(person: string, org: string): Promise<void>;
  blocked(person: string, org: string): Promise<boolean>;
};
type Deps = {
  store: { get(t: string, id: string): Promise<BixResource | null>; search?(t: string, q: Record<string, string>): Promise<BixResource[]>; commit(r: BixResource, p: BixResource): Promise<void> };
  invites: InviteStore;
  identify(req: Request): Promise<{ person: string | null }>;
  identities?: { list?(person: string): Promise<{ provider: string; subject: string; label: string | null }[]> };
  sendEmail?(to: string, subject: string, text: string): Promise<void>;
  appUrl: string;
  salt: string;
  now(): string;
  newId(): string;
  told(prev: BixResource | null, rec: BixResource, actor: string): void;
};

const RESERVED = new Set(["admin", "administrator", "support", "help", "dasig", "bayanihan", "bayani", "bix", "lgu", "official", "security", "staff", "team", "system", "root", "moderator", "mod", "everyone", "here", "null", "undefined", "me", "you", "network", "ecosystem"]);
/** BIX handle rules, plus the server's: not all digits, not an email or phone, not reserved. Returns a reason or null. */
export function handleWhy(v: string): string | null {
  if (v.length < 3 || v.length > 20) return "a username is 3 to 20 characters";
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(v)) return "use lowercase letters, numbers, dots and underscores, starting with a letter";
  if (/^\d+$/.test(v.replace(/[._]/g, "")) || /^\+?\d[\d.]{6,}$/.test(v)) return "a username can't be a number";
  if (RESERVED.has(v) || [...RESERVED].some((r) => v === `${r}.official` || v.startsWith("dasig.") || v.startsWith("bayanihan."))) return "that username is reserved";
  return null;
}
const ROLE_FOR: Record<string, string[]> = { Organization: ["volunteer", "member"], Initiative: ["volunteer"], Team: ["team-member"], Task: ["helper"] };
const hit = (m: Map<string, number[]>, k: string, max: number, ms: number) => { const now = Date.now(); const xs = (m.get(k) ?? []).filter((t) => now - t < ms); if (xs.length >= max) return false; m.set(k, [...xs, now]); return true; };

export function inviteRoutes(app: Hono, d: Deps) {
  const lookups = new Map<string, number[]>(), sends = new Map<string, number[]>(), perAddress = new Map<string, number[]>();
  const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");
  const emailHash = (email: string) => sha(`${d.salt}:${email.trim().toLowerCase()}`);
  const commit = async (prev: BixResource | null, next: BixResource, actor: { type: "person"; person: { reference: string } } | { type: "rule"; rule: string }) => {
    const r = applyChange(prev, next, { actor, permissions: [], now: d.now(), newId: d.newId });
    if (!r.ok) throw new Error(r.reasons.join("; "));
    await d.store.commit(r.record, r.provenance);
    return r.record;
  };
  const orgOf = async (t: BixResource): Promise<string | null> => {
    if (t.resourceType === "Organization") return `Organization/${t.id}`;
    const direct = (t["organization"] as { reference?: string } | undefined)?.reference; if (direct) return direct;
    for (const k of ["team", "partOf", "initiative"]) {
      const r = (t[k] as { reference?: string } | undefined)?.reference; if (!r) continue;
      const [tt, id] = r.split("/"); const x = await d.store.get(tt!, id!); if (x) { const o = await orgOf(x); if (o) return o; }
    }
    return null;
  };
  const rolesIn = async (person: string, org: string) => (await d.store.search?.("Role", { person, organization: org }) ?? []).filter((r) => r["status"] === "active");
  const code = (r: BixResource) => (r["code"] as { code?: string } | undefined)?.code ?? "";

  app.post("/$me/handle", async (c) => {
    const me = (await d.identify(c.req.raw)).person; if (!me) return c.json({ error: "sign in first" }, 401);
    const b = (await c.req.json().catch(() => ({}))) as { value?: string | null; findable?: boolean };
    const p = await d.store.get("Person", me.split("/")[1]!); if (!p) return c.json({ error: "not found" }, 404);
    const cur = p["handle"] as { value: string; findable?: boolean; changed?: string } | undefined;
    if (b.value === undefined && typeof b.findable === "boolean" && cur) {
      const rec = await commit(p, { ...p, meta: { version: p.meta.version + 1 }, handle: { ...cur, findable: b.findable } }, { type: "person", person: { reference: me } });
      return c.json({ handle: rec["handle"] });
    }
    const v = b.value === null ? null : String(b.value ?? "").trim().toLowerCase().replace(/^@/, "");
    if (v !== null) {
      const why = handleWhy(v); if (why) return c.json({ error: why }, 400);
      if (cur?.value === v) return c.json({ handle: cur });
      const owner = await d.invites.handleOwner(v);
      if (owner && owner.person !== me && (!owner.releasedAt || Date.now() - Date.parse(owner.releasedAt) < 30 * 86400000)) return c.json({ error: "that username is taken" }, 409);
    }
    const lastChange = (p["extension"] as { url: string; value: string }[] | undefined)?.find((x) => x.url === "bayanihan:handle-changed")?.value;
    if (cur && lastChange && Date.now() - Date.parse(lastChange) < 30 * 86400000) return c.json({ error: "you can change your username once every 30 days" }, 429);
    if (cur) await d.invites.releaseHandle(cur.value, d.now());
    if (v) await d.invites.setHandle(v, me);
    const ext = ((p["extension"] as { url: string; value: string }[] | undefined) ?? []).filter((x) => x.url !== "bayanihan:handle-changed");
    const next: BixResource = { ...p, meta: { version: p.meta.version + 1 }, extension: [...ext, { url: "bayanihan:handle-changed", value: d.now() }] };
    if (v) next["handle"] = { value: v, findable: cur?.findable ?? true }; else delete next["handle"];
    const rec = await commit(p, next, { type: "person", person: { reference: me } });
    return c.json({ handle: rec["handle"] ?? null });
  });

  app.get("/$handle/:value", async (c) => {
    const me = (await d.identify(c.req.raw)).person; if (!me) return c.json({ error: "sign in first" }, 401);
    if (!hit(lookups, me, 30, 60_000)) return c.json({ error: "too many lookups; wait a minute" }, 429);
    const v = c.req.param("value").trim().toLowerCase().replace(/^@/, "");
    const owner = await d.invites.handleOwner(v);
    const p = owner && !owner.releasedAt ? await d.store.get("Person", owner.person.split("/")[1]!) : null;
    const h = p?.["handle"] as { value: string; findable?: boolean } | undefined;
    if (!p || h?.value !== v || h.findable === false) return c.json({ error: "no one with that username" }, 404);
    return c.json({ person: `Person/${p.id}`, name: (p["name"] as { text: string }).text, ...(p["photo"] ? { photo: p["photo"] } : {}), handle: v });
  });

  app.post("/$invite", async (c) => {
    const me = (await d.identify(c.req.raw)).person; if (!me) return c.json({ error: "sign in first" }, 401);
    const b = (await c.req.json().catch(() => ({}))) as { target?: { reference?: string }; role?: string; handle?: string; email?: string; person?: string; message?: string };
    const [tt, tid] = b.target?.reference?.split("/") ?? [];
    const target = tt && tid && ROLE_FOR[tt] ? await d.store.get(tt, tid) : null;
    if (!target) return c.json({ error: "invite to a group, team, project or task" }, 400);
    const role = b.role ?? ROLE_FOR[tt!]![0]!;
    if (!ROLE_FOR[tt!]!.includes(role)) return c.json({ error: `that kind of invitation can't give "${role}"` }, 400);
    const org = await orgOf(target); if (!org) return c.json({ error: "that isn't part of a group" }, 400);
    // Who may invite (Organization.invitePolicy): the core team by default, or everyone in the group.
    const mine = await rolesIn(me, org);
    const groupRec = await d.store.get("Organization", org.split("/")[1]!);
    const core = mine.some((r) => ["officer", "core-member", "member"].includes(code(r)));
    if (!(core || (groupRec?.["invitePolicy"] === "members" && mine.length))) return c.json({ error: "in this group, the core team sends invitations" }, 403);
    if (role === "member" && !mine.some((r) => code(r) === "officer")) return c.json({ error: "only officers invite people onto the core team" }, 403);
    if (!hit(sends, me, 40, 86400000)) return c.json({ error: "you've sent a lot of invitations today; try again tomorrow" }, 429);
    const message = typeof b.message === "string" ? b.message.trim().slice(0, 280) : undefined;
    const inv = (invitee: string | null, via: string): BixResource => ({ resourceType: "Invitation", id: d.newId(), meta: { version: 1 }, target: { reference: `${tt}/${tid}` }, invitedBy: { reference: me },
      ...(invitee ? { invitee: { reference: invitee } } : {}), role, status: "sent", via, expires: new Date(Date.now() + 30 * 86400000).toISOString(), ...(message ? { message } : {}) });
    const send = async (invitee: string, via: string) => {
      if (invitee === me) return c.json({ error: "that's you" }, 400);
      if (await d.invites.blocked(invitee, org)) return c.json({ sent: true });            // blocked: say nothing
      const open = (await d.store.search?.("Invitation", { invitee }) ?? []).some((x) => x["status"] === "sent" && (x["target"] as { reference: string }).reference === `${tt}/${tid}`);
      if (open) return c.json({ sent: true });
      const rec = await commit(null, inv(invitee, via), { type: "person", person: { reference: me } });
      d.told(null, rec, me);
      return c.json({ sent: true, invitation: rec.id });
    };
    if (b.handle) {
      const v = b.handle.trim().toLowerCase().replace(/^@/, "");
      const owner = await d.invites.handleOwner(v);
      const p = owner && !owner.releasedAt ? await d.store.get("Person", owner.person.split("/")[1]!) : null;
      const h = p?.["handle"] as { value: string; findable?: boolean } | undefined;
      if (!p || h?.value !== v || h.findable === false) return c.json({ error: "no one with that username" }, 404);
      return send(`Person/${p.id}`, "username");
    }
    if (b.person) {  // someone you can already see (in this group, or worked with you): the app's Add people sheet
      if (!/^Person\/[\w-]+$/.test(b.person) || !(await d.store.get("Person", b.person.split("/")[1]!))) return c.json({ error: "not found" }, 404);
      return send(b.person, "in-app");
    }
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(email)) return c.json({ error: "that doesn't look like an email address" }, 400);
    if (!d.sendEmail) return c.json({ error: "this network doesn't send invitation emails" }, 404);
    const hash = await emailHash(email);
    // Same work and the same answer whether or not the address is known (privacy rule 2): the email always goes out,
    // and the invitation waits until that address signs in. Limits are per address too, silently.
    if (hit(perAddress, hash, 5, 7 * 86400000)) {
      const rec = await commit(null, inv(null, "email"), { type: "person", person: { reference: me } });
      await d.invites.saveEmail(rec.id, hash);
      const inviter = await d.store.get("Person", me.split("/")[1]!);
      const who = (inviter?.["name"] as { text?: string } | undefined)?.text ?? "Someone";
      const group = (groupRec?.["name"] as string | undefined) ?? "a group";
      await d.sendEmail(email, `${who} invited you to help ${group}`, `${who} invited you to help ${group} on the Bayanihan Network.\n\nOpen the invitation: ${d.appUrl}/invitations\n\nSign in with this email address (${email}), Google or Dasig.org. If you didn't expect this, you can ignore it; nothing happens unless you accept.\n`).catch(() => {});
    }
    return c.json({ sent: true });
  });

  app.get("/$invitations", async (c) => {
    const me = (await d.identify(c.req.raw)).person; if (!me) return c.json({ error: "sign in first" }, 401);
    // Claim invitations sent to any verified email of mine (privacy rule 1: matched by hash only).
    const emails = [...new Set(((await d.identities?.list?.(me)) ?? []).map((m) => m.label ?? (m.provider === "email" ? m.subject : null)).filter(Boolean) as string[])];
    for (const id of await d.invites.invitationsForHashes(await Promise.all(emails.map(emailHash)))) {
      const x = await d.store.get("Invitation", id);
      if (x && x["status"] === "sent" && !x["invitee"]) await commit(x, { ...x, meta: { version: x.meta.version + 1 }, invitee: { reference: me } }, { type: "rule", rule: "invitation-email-matched" });
      await d.invites.forgetEmail(id);
    }
    const mine = (await d.store.search?.("Invitation", { invitee: me }) ?? []);
    const out = [];
    for (const x of mine) {
      if (x["status"] === "sent" && Date.parse(String(x["expires"])) < Date.now()) { await commit(x, { ...x, meta: { version: x.meta.version + 1 }, status: "expired" }, { type: "rule", rule: "invitation-expired" }).catch(() => {}); continue; }
      if (x["status"] !== "sent") continue;
      const [tt, tid] = (x["target"] as { reference: string }).reference.split("/");
      const t = await d.store.get(tt!, tid!); const org = t ? await orgOf(t) : null; const g = org ? await d.store.get("Organization", org.split("/")[1]!) : null;
      const by = await d.store.get("Person", (x["invitedBy"] as { reference: string }).reference.split("/")[1]!);
      out.push({ id: x.id, role: x["role"], via: x["via"], message: x["message"] ?? null, expires: x["expires"],
        target: { reference: `${tt}/${tid}`, title: (t?.["title"] ?? t?.["name"] ?? "") as string }, group: g ? { id: g.id, name: g["name"] } : null,
        invitedBy: { reference: `Person/${by?.id}`, name: (by?.["name"] as { text?: string } | undefined)?.text ?? "Someone" } });
    }
    return c.json({ entry: out });
  });

  app.post("/$invitations/:id", async (c) => {
    const me = (await d.identify(c.req.raw)).person; if (!me) return c.json({ error: "sign in first" }, 401);
    const x = await d.store.get("Invitation", c.req.param("id"));
    const b = (await c.req.json().catch(() => ({}))) as { answer?: string };
    if (!x || x["status"] !== "sent") return c.json({ error: "that invitation isn't open any more" }, 404);
    const invitee = (x["invitee"] as { reference?: string } | undefined)?.reference, by = (x["invitedBy"] as { reference: string }).reference;
    const v = { ...x, meta: { version: x.meta.version + 1 } };
    if (b.answer === "withdraw") { if (me !== by) return c.json({ error: "only the sender can withdraw it" }, 403); await commit(x, { ...v, status: "withdrawn" }, { type: "person", person: { reference: me } }); return c.json({ status: "withdrawn" }); }
    if (me !== invitee) return c.json({ error: "this invitation is for someone else" }, 403);
    const [tt, tid] = (x["target"] as { reference: string }).reference.split("/");
    const t = await d.store.get(tt!, tid!); const org = t ? await orgOf(t) : null;
    if (b.answer === "decline" || b.answer === "block") {
      await commit(x, { ...v, status: "declined", ...(b.answer === "block" ? { blockFuture: true } : {}) }, { type: "person", person: { reference: me } });
      if (b.answer === "block" && org) await d.invites.block(me, org);
      return c.json({ status: "declined" });
    }
    if (b.answer !== "accept" || !t || !org) return c.json({ error: "answer accept, decline or block" }, 400);
    // Accepting creates what the invitation names, by rule (the invitation is the consent of both sides).
    const rule = { type: "rule" as const, rule: "invitation-accepted" };
    const role = String(x["role"]);
    if (!(await rolesIn(me, org)).length || role === "member")
      await commit(null, { resourceType: "Role", id: d.newId(), meta: { version: 1 }, person: { reference: me }, organization: { reference: org }, status: "active", period: { start: d.now() },
        code: { system: "bayanihan:role", code: role === "member" ? "member" : "volunteer-episodic" } }, rule);
    if (tt === "Team") {
      const parts = ((t["participant"] as { person: { reference: string }; status: string }[] | undefined) ?? []).filter((p) => p.person.reference !== me);
      await commit(t, { ...t, meta: { version: t.meta.version + 1 }, participant: [...parts, { person: { reference: me }, role: "volunteer", status: "active" }] }, rule);
    }
    if (tt === "Task") {  // a helper on that task only, not on its team (D6)
      const parts = ((t["participant"] as { person: { reference: string }; status: string }[] | undefined) ?? []).filter((p) => p.person.reference !== me);
      const slots = Number(t["slots"] ?? 1);
      const shift = slots > 1 || !["ready", "requested"].includes(String(t["status"]));
      await commit(t, { ...t, meta: { version: t.meta.version + 1 }, participant: [...parts, { person: { reference: me }, role: shift ? "helper" : "owner", status: "active" }],
        ...(shift ? {} : { status: "accepted", owner: { reference: me } }) }, rule);
    }
    const rec = await commit(x, { ...v, status: "accepted" }, { type: "person", person: { reference: me } });
    return c.json({ status: rec["status"], target: `${tt}/${tid}` });
  });
}
