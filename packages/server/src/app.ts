import { Hono } from "hono";
import { cors } from "hono/cors";
import { applyChange, replay, resourceTypes, toBundle, authorize, owningParty, signRecord, verifyRecord, verifyChallenge, countVotes, type Store, type BixResource, type Signature } from "@bayanihan/core";
import type { KeyStore } from "./keys.js";
import { prefixFor, withRef, REF_SYSTEM, type Sequences } from "./refs.js";
import { loadDirectory, permissionsForRecord, type Caller } from "./auth.js";
import { canCreate } from "./create.js";
import { ALLOWED_TYPES, MAX_FILE_BYTES, type FileStore } from "./files.js";
import { newToken, hashToken, type LinkTokens } from "./links.js";

export type ServerOptions = {
  store: Store & {
    search?(type: string, params: Record<string, string>): Promise<BixResource[]>;
    history?(type: string, id: string): Promise<BixResource[]>;
    provenanceFor?(target: string): Promise<BixResource[]>;
    version?(type: string, id: string, version: number): Promise<BixResource | null>;
    mentioning?(reference: string): Promise<BixResource[]>;
  };
  /** Secret halves of ShareLinks. Without it, links can't be created. */
  linkTokens?: LinkTokens;
  /** Phones paired with this hub. With it, POST /$pair is available. */
  devices?: { save(tokenHash: string, person: string): Promise<void>; personFor(tokenHash: string): Promise<string | null> };
  /** The pairing code shown on the hub as a QR. Changing it stops new pairings with the old code. */
  pairingCode?: () => string | null;
  /**
   * Open sign-up for a hosted server (the Dasig Ecosystem): GET /$challenge and POST /$join. A phone joins with a nickname,
   * or brings its Person; a Person with keys must sign the server's one-time challenge. `audience` is this server's public
   * address, bound into every proof so a signature made for one server can't be used on another.
   */
  openJoin?: { audience: string; perHour?: number };
  /** Origins allowed to call this server from a browser (the Dasig web app). Default: any. */
  corsOrigins?: string[];
  /** Turn CORS off on a phone or hub: only native apps call it, and React Native's Response has no body stream for middleware to rewrap. */
  cors?: boolean;
  /** Where files are kept. Without it, uploads are refused. */
  files?: FileStore;
  /** Counters for short references (LU 2027-24). Without it, records get none. */
  sequences?: Sequences;
  /** Group signing keys. Without it, completed work is not signed. */
  keys?: KeyStore;
  /** Who is calling: a BIX Person reference, or null for an anonymous visitor. */
  identify(req: Request): Promise<Caller>;
  /** Link a signed-in account to a new Person (POST /$me). */
  linkAccount?(authUserId: string, person: BixResource): Promise<void>;
  now(): string;
  newId(): string;
};

/** The standard BIX API (spec, "Interoperability"): FHIR-shaped, Core on every write. */
export function createApp(o: ServerOptions) {
  const app = new Hono();
  if (o.cors !== false) app.use("*", cors({ origin: o.corsOrigins ?? "*", allowHeaders: ["authorization", "content-type", "x-bix-person", "x-bix-link"], allowMethods: ["GET", "POST", "OPTIONS"] }));

  /** Before committing: point Provenance at the exact version, and sign completed work with the owning group's key. */
  /** New Tasks, Needs, Offers and Decisions in a project get a short reference from the server. */
  /** A Decision's outcome is counted here, never trusted from the client (spec: "Decisions and voting"). */
  async function recount(record: BixResource): Promise<BixResource> {
    if (record.resourceType !== "Decision" || record["status"] !== "decided" || !o.store.search) return record;
    const votes = await o.store.search("Vote", { decision: `Decision/${record.id}` });
    const out = countVotes(record, votes);
    return { ...record, status: out.status, outcome: { option: out.option, tally: out.tally, decidedAt: o.now() } };
  }

  async function reference(prev: BixResource | null, record: BixResource): Promise<BixResource> {
    if (prev || !o.sequences || !["Task", "Need", "Offer", "Decision"].includes(record.resourceType)) return record;
    const dir = await loadDirectory(o.store, null, record);
    const ini = dir.initiatives[0];
    if (!ini) return record;
    const p = prefixFor(ini);
    return withRef(record, `${p}-${await o.sequences.next(p)}`);
  }

  /** People in the same group see each other's name and photo (never contact details). */
  async function sharesGroup(a: string, b: string) {
    const orgs = async (p: string) => new Set((await o.store.search!("Role", { person: p })).filter((r) => r["status"] === "active").map((r) => (r["organization"] as { reference: string }).reference));
    const [x, y] = await Promise.all([orgs(a), orgs(b)]);
    return [...x].some((g) => y.has(g));
  }
  const personCard = (p: BixResource): BixResource => {
    const anon = p["credit"] === "anonymous";
    // bayanihan:profile-visibility "nickname-only": groups see the nickname, never the photo, skills or the line about you.
    const minimal = ((p["extension"] as { url: string; value: string }[] | undefined) ?? []).some((x) => x.url === "bayanihan:profile-visibility" && x.value === "nickname-only");
    return { resourceType: "Person", id: p.id, meta: p.meta, name: anon ? { text: "A volunteer", use: "nickname" } : p["name"], ...(p["photo"] && !anon && !minimal ? { photo: p["photo"] } : {}) };
  };

  /**
   * Who can see a group or project (extension bayanihan:visibility): "group" (members only; no invite links),
   * "invited" (members and people they invite; nothing public), "public" (a public summary can be listed).
   * A project is never more open than its group: the most restrictive of the two applies.
   */
  type Visibility = "group" | "invited" | "public";
  const RANK: Record<Visibility, number> = { group: 0, invited: 1, public: 2 };
  const ownVisibility = (r: BixResource | null | undefined): Visibility | null => {
    if (!r) return null;
    const v = ((r["extension"] as { url: string; value: string }[] | undefined) ?? []).find((x) => x.url === "bayanihan:visibility")?.value;
    if (v === "group" || v === "invited" || v === "public") return v;
    return r["publicSummary"] === false ? "invited" : "public";
  };
  async function visibilityFor(record: BixResource): Promise<Visibility> {
    const dir = await loadDirectory(o.store, null, record);
    const ini = record.resourceType === "Initiative" ? record : dir.initiatives[0];
    const orgRef = (ini?.["organization"] ?? record["organization"] ?? dir.teams[0]?.["organization"]) as { reference?: string } | undefined;
    const org = record.resourceType === "Organization" ? record : orgRef?.reference ? await o.store.get("Organization", orgRef.reference.split("/")[1]!) : null;
    const vs = [ownVisibility(org), record.resourceType === "Organization" ? null : ownVisibility(ini)].filter(Boolean) as Visibility[];
    return vs.length ? vs.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b)) : "public";
  }
  /** Changes that would show private work to outsiders are refused, whoever makes them. */
  async function privacyWhy(r: BixResource): Promise<string | null> {
    if (r.resourceType === "Task" && r["audience"] === "open" && (await visibilityFor(r)) !== "public")
      return "this group or project isn't public, so its work can't be shown to everyone; invite volunteers with a link instead";
    if (r.resourceType === "Initiative" && r["organization"]) {
      const org = await o.store.get("Organization", (r["organization"] as { reference: string }).reference.split("/")[1]!);
      const mine = ownVisibility(r)!, group = ownVisibility(org);
      if (group && RANK[mine] > RANK[group]) return "a project can't be more open than its group; change the group's setting first";
    }
    return null;
  }

  /** Whoever starts a group becomes its officer, recorded by rule. */
  async function founderRole(me: string, org: BixResource) {
    const role: BixResource = { resourceType: "Role", id: o.newId(), meta: { version: 1 }, person: { reference: me }, organization: { reference: `Organization/${org.id}` },
      code: { system: "bayanihan:role", code: "officer" }, status: "active", period: { start: o.now() } };
    const r = applyChange(null, role, { actor: { type: "rule", rule: "founder-is-officer" }, permissions: [], now: o.now(), newId: o.newId });
    if (r.ok) await o.store.commit(r.record, r.provenance);
  }

  /** Changing an existing record: the people on it or its lead; or a claim, or answering an ask, which Core's rules check. */
  async function canUpdate(me: string, prev: BixResource, next: BixResource): Promise<string | null> {
    if (prev.resourceType === "Task" && ["accepted", "in-progress", "completed"].includes(String(next["status"])) && prev["status"] !== next["status"] && ["ready", "requested"].includes(String(prev["status"]))) {
      for (const d of (next["dependsOn"] as { reference: string }[] | undefined) ?? []) {
        const [dt, did] = d.reference.split("/");
        const dep = await o.store.get(dt!, did!);
        if (dep && dep["status"] !== "completed") return `waiting on "${dep["title"] ?? "another task"}"`;
      }
    }
    const dir = await loadDirectory(o.store, me, prev);
    if (authorize(me, "edit", prev, dir).allowed) return null;
    if (prev.resourceType === "Task" && prev["status"] === "ready" && next["status"] === "accepted" && authorize(me, "claim", prev, dir).allowed) return null;
    if (prev.resourceType === "Task" && prev["status"] === "requested" && (prev["owner"] as { reference?: string } | undefined)?.reference === me) return null;
    if (prev.resourceType === "Person" && prev.id !== me.split("/")[1] && JSON.stringify(prev["publicKey"] ?? []) !== JSON.stringify(next["publicKey"] ?? [])) return "only the person can change their own keys";
    if (prev.resourceType === "Person" && (prev.id === me.split("/")[1] || permissionsForRecord(me, prev, dir).includes("member.manage"))) return null;
    if (prev.resourceType === "Organization" && permissionsForRecord(me, prev, dir).includes("org.manage")) return null;
    if (prev.resourceType === "Role" && permissionsForRecord(me, prev, dir).includes("member.manage")) return null;
    if (prev.resourceType === "Team" && permissionsForRecord(me, prev, dir).some((p) => ["task.assign", "member.manage", "org.manage"].includes(p))) return null;
    if (prev.resourceType === "Decision" || prev.resourceType === "Role" || prev.resourceType === "Initiative" || prev.resourceType === "Position") return permissionsForRecord(me, prev, dir).some((p) => ["initiative.plan", "org.manage", "task.assign", "member.manage"].includes(p)) ? null : "not yours to change";
    return "only the people on it, or its lead, can change this";
  }

  async function seal(prev: BixResource | null, record: BixResource, provenance: BixResource): Promise<BixResource> {
    const p = { ...provenance, target: [{ reference: `${record.resourceType}/${record.id}/_history/${record.meta.version}` }] };
    const justDone = record.resourceType === "Task" && record["status"] === "completed" && prev?.["status"] !== "completed";
    const justConfirmed = record.resourceType === "Task" && record["verification"] === "confirmed" && prev?.["verification"] !== "confirmed";
    if (!o.keys || !(justDone || justConfirmed)) return p;
    const dir = await loadDirectory(o.store, null, record);
    const own = owningParty(record, dir);
    const owner = own.organization ?? own.person;
    if (!owner) return p;
    const k = await o.keys.keyFor(owner);
    const sig = await signRecord(record, k.privateKey, { reference: owner }, k.keyId, o.now());
    return { ...p, signature: [sig] };
  }

  app.get("/", (c) =>
    c.html(`<!doctype html><meta charset="utf-8"><title>Bayanihan Server</title>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;color:#0F172A;line-height:1.5">
<h1>Bayanihan Server</h1><p>The reference BIX server. BIX v0.1 · Bayanihan Server 0.1.0</p>
<ul>
<li><a href="/metadata">GET /metadata</a>: what this server supports</li>
<li>GET /{type}/{id}: read a record, e.g. <code>/Task/&lt;id&gt;</code></li>
<li>GET /{type}?field=value: search, e.g. <a href="/Task">/Task</a></li>
<li>GET /{type}/{id}/_history: every version of a record</li>
<li>POST / with a <code>transaction</code> or <code>sync</code> Bundle: make changes</li>
</ul></body>`));

  app.get("/metadata", (c) =>
    c.json({ resourceType: "CapabilityStatement", bix: "0.1", software: { name: "Bayanihan Server", version: "0.1.0" }, resourceTypes, interactions: ["read", "search", "history", "transaction", "export"] }));

  app.get("/:type/:id/_history", async (c, next) => {
    const { type, id } = c.req.param();
    if (type.startsWith("$")) return next();
    if (!o.store.history) return c.json({ error: "history not supported by this store" }, 501);
    return c.json(toBundle(await o.store.history(type, id), "export", o.newId(), o.now()));
  });

  app.get("/:type/:id", async (c, next) => {
    const { type, id } = c.req.param();
    if (type.startsWith("$") || id.startsWith("$")) return next();
    if (!resourceTypes.includes(type)) return c.json({ error: `unknown type ${type}` }, 404);
    const r = await o.store.get(type, id);
    if (!r) return c.json({ error: "not found" }, 404);
    const me = (await o.identify(c.req.raw)).person;
    const dir = await loadDirectory(o.store, me, r);
    if (authorize(me, "view", r, dir).allowed) return c.json(r);
    if (authorize(me, "view-summary", r, dir).allowed && (type === "Initiative" || type === "Organization")) return c.json(summary(r));
    if (type === "Person" && me && o.store.search && (await sharesGroup(me, `Person/${id}`))) return c.json(personCard(r));
    return c.json({ error: "not found" }, 404); // never reveal that a private record exists
  });

  app.get("/:type", async (c, next) => {
    const type = c.req.param("type");
    if (type.startsWith("$")) return next();
    if (!resourceTypes.includes(type)) return c.json({ error: `unknown type ${type}` }, 404);
    if (!o.store.search) return c.json({ error: "search not supported by this store" }, 501);
    const me = (await o.identify(c.req.raw)).person;
    const visible: BixResource[] = [];
    for (const r of await o.store.search(type, c.req.query())) {
      const dir = await loadDirectory(o.store, me, r);
      if (authorize(me, "view", r, dir).allowed) visible.push(r);
      else if (authorize(me, "view-summary", r, dir).allowed && (type === "Initiative" || type === "Organization")) visible.push(summary(r));
    }
    return c.json(toBundle(visible, "export", o.newId(), o.now()));
  });

  /** POST a Bundle. "transaction": one change, applied now. "sync": offline changes, replayed in order. */
  app.post("/", async (c) => {
    const me = (await o.identify(c.req.raw)).person;
    if (!me) return c.json({ error: "sign in, or use a link" }, 401);
    const ctxFor = async (r: BixResource) => {
      const prev = await o.store.get(r.resourceType, r.id);
      const dir = await loadDirectory(o.store, me, prev ?? r);
      return { actor: { type: "person" as const, person: { reference: me } }, permissions: permissionsForRecord(me, prev ?? r, dir), newId: o.newId };
    };
    const bundle = (await c.req.json()) as { type?: string; entry?: { resource: BixResource; occurredAt?: string }[] };
    const entries = bundle.entry ?? [];
    if (bundle.type === "transaction") {
      const results = [];
      for (const e of entries) {
        const prev = await o.store.get(e.resource.resourceType, e.resource.id);
        const why = (prev ? await canUpdate(me, prev, e.resource) : canCreate(me, e.resource, await loadDirectory(o.store, me, e.resource))) ?? (await privacyWhy(e.resource));
        if (why) { results.push({ ok: false, reasons: [why], current: prev }); continue; }
        const r = applyChange(prev, e.resource, { ...(await ctxFor(e.resource)), now: o.now() });
        let committed = r.ok ? await recount(await reference(prev, r.record)) : null;
        if (r.ok && committed) {
          await o.store.commit(committed, await seal(prev, committed, r.provenance));
          if (!prev && committed.resourceType === "Organization") await founderRole(me, committed);
        }
        results.push(r.ok ? { ok: true, record: committed } : { ok: false, reasons: r.reasons, current: prev });
      }
      return c.json({ resourceType: "Bundle", type: "transaction-response", entry: results }, results.every((r) => r.ok) ? 200 : 409);
    }
    if (bundle.type === "sync") {
      const changes = [];
      const refusedNew = [];
      for (const e of entries) {
        const prevRec = await o.store.get(e.resource.resourceType, e.resource.id);
        const why = (prevRec ? await canUpdate(me, prevRec, e.resource) : canCreate(me, e.resource, await loadDirectory(o.store, me, e.resource))) ?? (await privacyWhy(e.resource));
        if (why) { refusedNew.push({ record: e.resource, reasons: [why], current: prevRec }); continue; }
        changes.push({ record: e.resource, occurredAt: e.occurredAt ?? o.now(), context: await ctxFor(e.resource) });
      }
      const sealing = { get: (t: string, i: string) => o.store.get(t, i),
        commit: async (rec: BixResource, prov: BixResource) => { const prev = await o.store.get(rec.resourceType, rec.id); const ref = await reference(prev, rec); await o.store.commit(ref, await seal(prev, ref, prov)); } };
      const out = await replay(sealing, changes, o.now());
      return c.json({ resourceType: "Bundle", type: "sync-response", accepted: out.accepted.map((a) => a.record), refused: [...refusedNew, ...out.refused] });
    }
    return c.json({ error: "Bundle.type must be transaction or sync" }, 400);
  });

  /** Rule 18: a person exports every record that names them, any time, without asking anyone. */
  app.get("/Person/:id/$export", async (c) => {
    const me = (await o.identify(c.req.raw)).person;
    const ref = `Person/${c.req.param("id")}`;
    if (me !== ref) return c.json({ error: "only you can export your own records" }, 403);
    if (!o.store.mentioning) return c.json({ error: "export not supported by this store" }, 501);
    const own = await o.store.get("Person", c.req.param("id"));
    const recs = [...(own ? [own] : []), ...(await o.store.mentioning(ref)).filter((r) => r.id !== own?.id)];
    const visible = [];
    for (const r of recs) if (r.resourceType === "Provenance" || authorize(me, "view", r, await loadDirectory(o.store, me, r)).allowed) visible.push(r);
    return c.json(toBundle(visible, "export", o.newId(), o.now()));
  });

  /** Rule 18: a group exports everything it owns. Needs org.manage. */
  app.get("/Organization/:id/$export", async (c) => {
    const me = (await o.identify(c.req.raw)).person;
    const org = await o.store.get("Organization", c.req.param("id"));
    if (!org || !o.store.mentioning) return c.json({ error: "not found" }, 404);
    const perms = permissionsForRecord(me, org, await loadDirectory(o.store, me, org));
    if (!perms.includes("org.manage")) return c.json({ error: "exporting a group needs org.manage" }, 403);
    const seen = new Map<string, BixResource>([[`Organization/${org.id}`, org]]);
    const add = (rs: BixResource[]) => rs.forEach((r) => seen.set(`${r.resourceType}/${r.id}`, r));
    add(await o.store.mentioning(`Organization/${org.id}`));
    // One level further: everything in its projects and teams.
    for (const r of [...seen.values()].filter((x) => x.resourceType === "Initiative" || x.resourceType === "Team")) add(await o.store.mentioning(`${r.resourceType}/${r.id}`));
    for (const r of [...seen.values()].filter((x) => x.resourceType === "Task" || x.resourceType === "Need")) {
      const prov = o.store.provenanceFor ? await o.store.provenanceFor(`${r.resourceType}/${r.id}`) : [];
      add(prov);
    }
    return c.json(toBundle([...seen.values()], "export", o.newId(), o.now()));
  });

  /**
   * Upload a file (raw body). Returns a BIX Attachment to put on a record's attachment[] or output[].
   * Kept by this server; nobody needs an outside cloud account.
   */
  app.post("/$files", async (c) => {
    const me = (await o.identify(c.req.raw)).person;
    if (!me) return c.json({ error: "sign in to add files" }, 401);
    if (!o.files) return c.json({ error: "this server does not keep files" }, 501);
    let type = (c.req.header("content-type") ?? "").split(";")[0]!.trim();
    let bytes: Uint8Array;
    if (type === "application/json" && c.req.query("b64") === "1") {
      // For phones: React Native can't send binary bodies reliably, so files may come as base64 JSON.
      const j = (await c.req.json()) as { contentType?: string; data?: string };
      type = j.contentType ?? "";
      bytes = Uint8Array.from(atob(j.data ?? ""), (ch) => ch.charCodeAt(0));
    } else bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!ALLOWED_TYPES.some((t) => t.test(type))) return c.json({ error: `files of type ${type || "unknown"} aren't accepted` }, 415);
    if (!bytes.byteLength) return c.json({ error: "empty file" }, 400);
    if (bytes.byteLength > MAX_FILE_BYTES) return c.json({ error: "files up to 15 MB" }, 413);
    const showsMinors = c.req.query("showsMinors") === "true";
    const m = await o.files.put(bytes, { contentType: type, uploadedBy: me, showsMinors });
    const title = c.req.query("title");
    return c.json({ contentType: m.contentType, url: `/$files/${m.hash}`, hash: m.hash, size: m.size, ...(title ? { title } : {}), showsMinors: m.showsMinors, capturedAt: o.now() }, 201);
  });

  /** Download a file: its uploader, or anyone who may view a record that holds it. Photos showing children never leave the group. */
  app.get("/$files/:hash", async (c) => {
    const me = (await o.identify(c.req.raw)).person;
    if (!me || !o.files) return c.json({ error: "not found" }, 404);
    const f = await o.files.get(c.req.param("hash"));
    if (!f) return c.json({ error: "not found" }, 404);
    let allowed = f.meta.uploadedBy === me;
    if (!allowed && o.store.mentioning) {
      for (const r of await o.store.mentioning(f.meta.hash)) {
        if (r.resourceType === "Provenance") continue;
        const dir = await loadDirectory(o.store, me, r);
        const member = permissionsForRecord(me, r, dir).some((p) => p === "member" || p === "team.member");
        if (authorize(me, "view", r, dir).allowed && (!f.meta.showsMinors || member)) { allowed = true; break; }
      }
    }
    if (!allowed) return c.json({ error: "not found" }, 404);
    if (c.req.query("b64") === "1") {
      let bin = ""; for (let i = 0; i < f.bytes.length; i += 0x8000) bin += String.fromCharCode(...f.bytes.subarray(i, i + 0x8000));
      return c.json({ contentType: f.meta.contentType, data: btoa(bin) });
    }
    return new Response(f.bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": f.meta.contentType, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
  });

  // ---------- Share links (spec: ShareLink; growth loop 1) ----------

  /** Create a link to a team, task or project. Returns the URL token once; only its hash is kept. */
  app.post("/$links", async (c) => {
    const me = (await o.identify(c.req.raw)).person;
    if (!me) return c.json({ error: "sign in first" }, 401);
    if (!o.linkTokens) return c.json({ error: "this server does not make links" }, 501);
    const body = (await c.req.json()) as { target: { reference: string }; grants: string[]; audience?: string; preview?: string; expires?: string; role?: string; approval?: boolean };
    const [t, id] = body.target?.reference?.split("/") ?? [];
    const target = t && id ? await o.store.get(t, id) : null;
    if (!target) return c.json({ error: "target not found" }, 404);
    if ((await visibilityFor(target)) === "group") return c.json({ error: "this group is set to only its members, so it has no invite links; change who can see it to invite people" }, 403);
    const link: BixResource = { resourceType: "ShareLink", id: o.newId(), meta: { version: 1 }, target: body.target, grants: body.grants,
      audience: body.audience ?? "anyone-with-link", preview: body.preview ?? "title-only", createdBy: { reference: me }, status: "active", ...(body.expires ? { expires: body.expires } : {}) };
    // The role a group link gives (stored as an extension; BIX ShareLink grants say what, this says as whom).
    const ext: { url: string; value: string }[] = [];
    if (body.role && (t === "Organization" || t === "Initiative")) ext.push({ url: "bayanihan:link-role", value: body.role });
    if (body.approval) ext.push({ url: "bayanihan:link-approval", value: "required" });
    if (ext.length) (link as Record<string, unknown>)["extension"] = ext;
    const dir = await loadDirectory(o.store, me, target);
    const why = canCreate(me, { ...link, owner: body.target, organization: target["organization"] } as BixResource, dir);
    if (why && !permissionsForRecord(me, target, dir).length) return c.json({ error: why }, 403);
    const r = applyChange(null, link, { actor: { type: "person", person: { reference: me } }, permissions: [], now: o.now(), newId: o.newId });
    if (!r.ok) return c.json({ error: r.reasons }, 400);
    await o.store.commit(r.record, r.provenance);
    const token = newToken();
    await o.linkTokens.save(await hashToken(token), r.record.id);
    return c.json({ link: r.record, token, ...(o.pairingCode && o.devices ? { pairingCode: o.pairingCode() } : {}) }, 201);
  });

  /** Links you made, or links to something you lead. */
  app.get("/$links", async (c) => {
    const me = (await o.identify(c.req.raw)).person;
    if (!me || !o.store.search) return c.json({ error: "sign in first" }, 401);
    const all = await o.store.search("ShareLink", {});
    const mine = [];
    for (const l of all) {
      const [t, id] = (l["target"] as { reference: string }).reference.split("/");
      const target = await o.store.get(t!, id!);
      const lead = target ? permissionsForRecord(me, target, await loadDirectory(o.store, me, target)).some((p) => ["task.assign", "member.manage", "org.manage"].includes(p)) : false;
      if ((l["createdBy"] as { reference: string }).reference === me || lead) mine.push({ link: l, target: target ? { resourceType: target.resourceType, id: target.id, title: target["title"] ?? target["name"] } : null });
    }
    return c.json(mine);
  });
  app.post("/$links/:id/revoke", async (c) => {
    const me = (await o.identify(c.req.raw)).person;
    const l = await o.store.get("ShareLink", c.req.param("id"));
    if (!me || !l) return c.json({ error: "not found" }, 404);
    const [t, id] = (l["target"] as { reference: string }).reference.split("/");
    const target = await o.store.get(t!, id!);
    const lead = target ? permissionsForRecord(me, target, await loadDirectory(o.store, me, target)).some((p) => ["task.assign", "member.manage", "org.manage"].includes(p)) : false;
    if ((l["createdBy"] as { reference: string }).reference !== me && !lead) return c.json({ error: "not yours to turn off" }, 403);
    const next = { ...l, meta: { ...l.meta, version: l.meta.version + 1 }, status: "revoked" };
    const r = applyChange(l, next, { actor: { type: "person", person: { reference: me } }, permissions: [], now: o.now(), newId: o.newId });
    if (!r.ok) return c.json({ error: r.reasons }, 409);
    await o.store.commit(r.record, r.provenance);
    return c.json(r.record);
  });

  async function openLink(token: string) {
    if (!o.linkTokens) return null;
    const id = await o.linkTokens.find(await hashToken(token));
    const link = id ? await o.store.get("ShareLink", id) : null;
    if (!link || link["status"] !== "active") return null;
    if (link["expires"] && String(link["expires"]) < o.now()) return null;
    const [t, tid] = (link["target"] as { reference: string }).reference.split("/");
    const target = await o.store.get(t!, tid!);
    return target ? { link, target } : null;
  }

  /** What a link points to, as much as it allows: the page someone sees before joining or claiming. */
  app.get("/$link/:token", async (c) => {
    const l = await openLink(c.req.param("token"));
    if (!l) return c.json({ error: "this link has expired or was turned off" }, 404);
    const { link, target } = l;
    const preview = link["preview"] as string;
    const base = { resourceType: target.resourceType, id: target.id, grants: link["grants"], createdBy: link["createdBy"] };
    if (preview === "generic") return c.json({ ...base, title: "You're invited to a group on Dasig" });
    const dir = await loadDirectory(o.store, null, target);
    const org = dir.initiatives[0]?.["organization"] ?? target["organization"];
    const orgRec = org ? await o.store.get("Organization", (org as { reference: string }).reference.split("/")[1]!) : null;
    const inviter = await o.store.get("Person", (link["createdBy"] as { reference: string }).reference.split("/")[1]!);
    const people = ((target["participant"] as { status: string }[] | undefined) ?? []).filter((p) => p.status === "active").length;
    const page = { ...base, title: target["title"] ?? target["name"], organization: orgRec ? { name: orgRec["name"], image: orgRec["image"] } : null,
      project: dir.initiatives[0] ? { title: dir.initiatives[0]["title"] } : null, invitedBy: inviter ? (inviter["name"] as { text: string }).text : null, people };
    return c.json(preview === "full" ? { ...page, description: target["description"], status: target["status"] } : page);
  });

  /** Join the team a link points to, as a volunteer (spec: joining a team creates a Role). */
  app.post("/$link/:token/join", async (c) => {
    const me = (await o.identify(c.req.raw)).person;
    if (!me) return c.json({ error: "tell us your name first" }, 401);
    const l = await openLink(c.req.param("token"));
    if (l && (await visibilityFor(l.target)) === "group") return c.json({ error: "this link was turned off" }, 404);
    const linkExt = ((l?.link["extension"] as { url: string; value: string }[] | undefined) ?? []);
    const approval = linkExt.some((x) => x.url === "bayanihan:link-approval" && x.value === "required");
    // A project link joins its group as a volunteer; the person then sees the project and chooses a team.
    if (l && l.target.resourceType === "Initiative" && (l.link["grants"] as string[]).includes("join-org") && l.target["organization"]) {
      const orgRef = l.target["organization"] as { reference: string };
      const org = await o.store.get("Organization", orgRef.reference.split("/")[1]!);
      if (org) l.target = { ...org, ["__project"]: l.target } as BixResource;
    }
    if (l && l.target.resourceType === "Organization" && (l.link["grants"] as string[]).includes("join-org")) {
      if (((l.link["blocked"] as { reference: string }[] | undefined) ?? []).some((b) => b.reference === me)) return c.json({ error: "this link can't add you" }, 403);
      const org = { reference: `Organization/${l.target.id}` };
      const existing = o.store.search ? (await o.store.search("Role", { person: me, organization: org.reference })).find((r) => r["status"] === "active") : null;
      if (existing) return c.json(existing);
      const code = linkExt.find((x) => x.url === "bayanihan:link-role")?.value ?? "volunteer-episodic";
      const asked = o.store.search ? (await o.store.search("Role", { person: me, organization: org.reference })).find((r) => r["status"] === "requested") : null;
      if (approval && asked) return c.json(asked);
      const role: BixResource = { resourceType: "Role", id: o.newId(), meta: { version: 1 }, person: { reference: me }, organization: org, code: { system: "bayanihan:role", code }, status: approval ? "requested" : "active", period: { start: o.now() } };
      const rr = applyChange(null, role, { actor: { type: "rule", rule: "join-through-link" }, permissions: [], now: o.now(), newId: o.newId });
      if (!rr.ok) return c.json({ error: rr.reasons }, 409);
      await o.store.commit(rr.record, rr.provenance);
      return c.json(rr.record);
    }
    if (!l || !(l.link["grants"] as string[]).includes("join-team") || l.target.resourceType !== "Team") return c.json({ error: "this link can't add you to a team" }, 404);
    if (((l.link["blocked"] as { reference: string }[] | undefined) ?? []).some((b) => b.reference === me)) return c.json({ error: "this link can't add you" }, 403);
    const team = l.target;
    const parts = (team["participant"] as { person: { reference: string }; role: string; status: string }[] | undefined) ?? [];
    if (parts.some((p) => p.person.reference === me && p.status === "active")) return c.json(team);
    const rule = { actor: { type: "rule" as const, rule: "join-through-link" }, permissions: [], now: o.now(), newId: o.newId };
    const org = team["organization"] as { reference: string };
    if (o.store.search && !(await o.store.search("Role", { person: me, organization: org.reference })).some((r) => r["status"] === "active")) {
      const role: BixResource = { resourceType: "Role", id: o.newId(), meta: { version: 1 }, person: { reference: me }, organization: org,
        code: { system: "bayanihan:role", code: "volunteer-episodic" }, status: approval ? "requested" : "active", period: { start: o.now() } };
      const rr = applyChange(null, role, rule); if (rr.ok) await o.store.commit(rr.record, rr.provenance);
    }
    if (parts.some((p) => p.person.reference === me && p.status === "requested")) return c.json(team);
    const next: BixResource = { ...team, meta: { ...team.meta, version: team.meta.version + 1 }, participant: [...parts, { person: { reference: me }, role: "volunteer", status: approval ? "requested" : "active" }] };
    const r = applyChange(team, next, rule);
    if (!r.ok) return c.json({ error: r.reasons }, 409);
    await o.store.commit(r.record, r.provenance);
    return c.json(r.record);
  });

  /** Look up a record by its short reference, e.g. /$ref/LU 2027-24. Same access rules as reading it. */
  app.get("/$ref/:ref", async (c) => {
    if (!o.store.search) return c.json({ error: "not found" }, 404);
    const want = c.req.param("ref").toUpperCase();
    const me = (await o.identify(c.req.raw)).person;
    for (const type of ["Task", "Need", "Offer", "Decision"]) {
      for (const r of await o.store.search(type, { [REF_SYSTEM]: want })) {
        if (authorize(me, "view", r, await loadDirectory(o.store, me, r)).allowed) return c.json(r);
      }
    }
    return c.json({ error: "not found" }, 404);
  });

  /** A group's (or person's) public key, so anyone can check its signatures. */
  app.get("/$keys/:type/:id", async (c) => {
    const k = o.keys && (await o.keys.publicKeyFor(`${c.req.param("type")}/${c.req.param("id")}`));
    return k ? c.json({ owner: `${c.req.param("type")}/${c.req.param("id")}`, keyId: k.keyId, alg: "Ed25519", publicKey: k.publicKey }) : c.json({ error: "no key" }, 404);
  });

  /** Check a record's signatures: who signed which version, and whether it is unchanged. */
  app.get("/:type/:id/$verify", async (c) => {
    const { type, id } = c.req.param();
    const r = await o.store.get(type, id);
    if (!r || !o.store.provenanceFor || !o.store.version || !o.keys) return c.json({ error: "not found" }, 404);
    const me = (await o.identify(c.req.raw)).person;
    if (!authorize(me, "view", r, await loadDirectory(o.store, me, r)).allowed) return c.json({ error: "not found" }, 404);
    const checks = [];
    for (const p of await o.store.provenanceFor(`${type}/${id}`)) {
      for (const sig of (p["signature"] as Signature[] | undefined) ?? []) {
        const v = Number(((p["target"] as { reference: string }[])[0]!.reference.split("/_history/")[1]));
        const signed = await o.store.version(type, id, v);
        const pub = await o.keys.publicKeyFor(sig.who.reference);
        const ok = !!signed && !!pub && (await verifyRecord(signed, sig, pub.publicKey));
        checks.push({ version: v, signedBy: sig.who.reference, when: sig.when, unchanged: ok });
      }
    }
    return c.json({ record: `${type}/${id}`, signatures: checks, allValid: checks.length > 0 && checks.every((x) => x.unchanged) });
  });

  /**
   * Pair a phone with this hub (spec: hubs pair by QR). The QR carries the hub's address and a pairing code.
   * The phone sends the code and a nickname; the hub creates (or reuses) its Person and returns a device token.
   */
  // ── Open sign-up (hosted servers) ────────────────────────────────────────────
  const challenges = new Map<string, number>();
  const joins = new Map<string, number[]>();
  const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  app.get("/$challenge", (c) => {
    if (!o.openJoin) return c.json({ error: "this server doesn't take sign-ups" }, 404);
    const now = Date.now();
    for (const [k, t] of challenges) if (now - t > 5 * 60_000) challenges.delete(k);
    const challenge = newToken();
    challenges.set(challenge, now);
    return c.json({ challenge, audience: o.openJoin.audience, expiresIn: 300 });
  });
  app.post("/$join", async (c) => {
    if (!o.openJoin || !o.devices) return c.json({ error: "this server doesn't take sign-ups" }, 404);
    const ip = clientIp(c.req.raw), now = Date.now();
    const recent = (joins.get(ip) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= (o.openJoin.perHour ?? 10)) return c.json({ error: "too many sign-ups from here; try again in an hour" }, 429);
    recent.push(now); joins.set(ip, recent);
    const body = (await c.req.json().catch(() => ({}))) as { nickname?: string; person?: BixResource; challenge?: string; proof?: string };
    const brought = body.person?.resourceType === "Person" ? body.person : null;
    let person = brought ? await o.store.get("Person", brought.id) : null;
    const keys = (((person ?? brought)?.["publicKey"] as { key: string; status: string }[] | undefined) ?? []).filter((k) => k.status === "active");
    if (person && !keys.length) return c.json({ error: "that person is already here; sign in from the phone that has their key" }, 409);
    if (keys.length) {
      const fresh = body.challenge && challenges.has(body.challenge) && now - challenges.get(body.challenge)! < 5 * 60_000;
      if (body.challenge) challenges.delete(body.challenge);
      const who = `Person/${(person ?? brought)!.id}`;
      if (!fresh || !body.proof || !keys.some((k) => verifyChallenge(body.challenge!, who, o.openJoin!.audience, body.proof!, k.key)))
        return c.json({ error: "this phone can't prove it's that person" }, 403);
    }
    if (!person) {
      const nickname = (body.nickname ?? (brought?.["name"] as { text?: string } | undefined)?.text ?? "Friend").toString().trim().slice(0, 60) || "Friend";
      const p: BixResource = brought ? { ...brought, meta: { version: 1 } } : { resourceType: "Person", id: o.newId(), meta: { version: 1 }, name: { text: nickname, use: "nickname" }, credit: "nickname", sharing: "private" };
      delete (p as Record<string, unknown>)["managedBy"];
      const r = applyChange(null, p, { actor: { type: "person", person: { reference: `Person/${p.id}` } }, permissions: [], now: o.now(), newId: o.newId });
      if (!r.ok) return c.json({ error: r.reasons }, 400);
      await o.store.commit(r.record, r.provenance);
      person = r.record;
    }
    const token = newToken();
    await o.devices.save(await hashToken(token), `Person/${person.id}`);
    return c.json({ person, token }, 201);
  });

  app.post("/$pair", async (c) => {
    if (!o.devices || !o.pairingCode) return c.json({ error: "this server is not a hub" }, 501);
    const body = (await c.req.json()) as { code?: string; nickname?: string; person?: BixResource; proof?: string };
    const code = o.pairingCode();
    if (!code || body.code !== code) return c.json({ error: "this pairing code isn't valid; scan the hub's QR again" }, 403);
    let person = body.person && body.person.resourceType === "Person" ? await o.store.get("Person", body.person.id) : null;
    // A Person with keys can only be paired by a phone holding one of them: it signs the pairing code.
    const keys = ((person ?? body.person)?.["publicKey"] as { key: string; status: string }[] | undefined ?? []).filter((k) => k.status === "active");
    if (keys.length) {
      const who = `Person/${(person ?? body.person)!.id}`;
      if (!body.proof || !keys.some((k) => verifyChallenge(code, who, "bix-pair", body.proof!, k.key))) return c.json({ error: "this phone can't prove it's that person" }, 403);
    }
    if (!person) {
      const p: BixResource = body.person?.resourceType === "Person" ? { ...body.person, meta: { version: 1 } } : { resourceType: "Person", id: o.newId(), meta: { version: 1 }, name: { text: body.nickname || "Friend", use: "nickname" }, credit: "nickname", sharing: "private" };
      const r = applyChange(null, p, { actor: { type: "person", person: { reference: `Person/${p.id}` } }, permissions: [], now: o.now(), newId: o.newId });
      if (!r.ok) return c.json({ error: r.reasons }, 400);
      await o.store.commit(r.record, r.provenance);
      person = r.record;
    }
    const token = newToken();
    await o.devices.save(await hashToken(token), `Person/${person.id}`);
    return c.json({ person, token }, 201);
  });

  /** How many have voted, and the counts once results may be shown (spec: showResults). */
  /**
   * What the caller may do with one record, so an app shows only the controls the server will accept.
   * `edit` covers details, files and cancelling (BIX never deletes: a cancelled record keeps its history).
   */
  app.get("/:type/:id/$can", async (c) => {
    const { type, id } = c.req.param();
    if (!resourceTypes.includes(type)) return c.json({ error: `unknown type ${type}` }, 404);
    const r = await o.store.get(type, id);
    const me = (await o.identify(c.req.raw)).person;
    if (!r || !me) return c.json({ error: "not found" }, 404);
    const dir = await loadDirectory(o.store, me, r);
    if (!authorize(me, "view", r, dir).allowed) return c.json({ error: "not found" }, 404);
    const edit = (await canUpdate(me, r, r)) === null;
    const personal = !!(r["person"] && !r["organization"]);
    const who = type === "Initiative" ? (personal ? "Only you can change this project." : "Officers and core members can change this project.")
      : type === "Task" ? "The people on it and the team's lead can change this."
      : type === "Organization" ? "Officers can change the group's details."
      : "The people in charge of it can change this.";
    return c.json({ edit, who });
  });

  app.get("/Decision/:id/$tally", async (c) => {
    const me = (await o.identify(c.req.raw)).person;
    const d = await o.store.get("Decision", c.req.param("id"));
    if (!d || !o.store.search || !authorize(me, "view", d, await loadDirectory(o.store, me, d)).allowed) return c.json({ error: "not found" }, 404);
    const votes = await o.store.search("Vote", { decision: `Decision/${d.id}` });
    const out = countVotes(d, votes);
    const voters = new Set(votes.map((v) => (v["voter"] as { reference: string }).reference));
    const mine = votes.filter((v) => (v["voter"] as { reference: string }).reference === me).sort((a, b) => String(b["cast"]).localeCompare(String(a["cast"])))[0];
    const show = d["status"] === "decided" || (d["showResults"] === "after-voting" && !!mine);
    return c.json({ voted: voters.size, eligible: ((d["eligible"] as unknown[]) ?? []).length, mine: mine?.["choice"] ?? null, tally: show ? out.tally : null });
  });

  /** Ask to delete your account: after 14 days your profile is removed; groups keep the work, unnamed (spec: Privacy and safety). */
  app.post("/$me/delete", async (c) => {
    const me = (await o.identify(c.req.raw)).person;
    if (!me) return c.json({ error: "sign in first" }, 401);
    const p = (await o.store.get("Person", me.split("/")[1]!))!;
    const cancel = c.req.query("cancel") === "1";
    const due = new Date(Date.now() + 14 * 86400000).toISOString();
    const ext = ((p["extension"] as { url: string }[] | undefined) ?? []).filter((x) => x.url !== "bayanihan:delete-after");
    const next = { ...p, meta: { ...p.meta, version: p.meta.version + 1 }, extension: cancel ? ext : [...ext, { url: "bayanihan:delete-after", value: due }] };
    const r = applyChange(p, next, { actor: { type: "person", person: { reference: me } }, permissions: [], now: o.now(), newId: o.newId });
    if (!r.ok) return c.json({ error: r.reasons }, 409);
    await o.store.commit(r.record, r.provenance);
    return c.json({ deleteAfter: cancel ? null : due });
  });
  /** Remove profiles whose grace period has ended. Run on each start of a session. */
  async function processDeletions(me: string) {
    const p = await o.store.get("Person", me.split("/")[1]!);
    const due = ((p?.["extension"] as { url: string; value: string }[] | undefined) ?? []).find((x) => x.url === "bayanihan:delete-after")?.value;
    if (!p || !due || due > o.now()) return;
    const gone: BixResource = { resourceType: "Person", id: p.id, meta: { ...p.meta, version: p.meta.version + 1 }, name: { text: "A former volunteer", use: "nickname" }, credit: "anonymous", sharing: "private" };
    const r = applyChange(p, gone, { actor: { type: "rule", rule: "account-deletion" }, permissions: [], now: o.now(), newId: o.newId });
    if (r.ok) await o.store.commit(r.record, r.provenance);
  }

  /** First sign-in: create the caller's Person (nickname is enough) and link the account. */
  app.post("/$me", async (c) => {
    const caller = await o.identify(c.req.raw);
    if (caller.person) { await processDeletions(caller.person); return c.json(await o.store.get("Person", caller.person.split("/")[1]!)); }
    if (!caller.authUserId) return c.json({ error: "sign in first" }, 401);
    if (!o.linkAccount) return c.json({ error: "this server does not link accounts" }, 501);
    const body = (await c.req.json()) as { nickname?: string };
    const id = o.newId();
    const person: BixResource = { resourceType: "Person", id, meta: { version: 1 }, name: { text: body.nickname || "Friend", use: "nickname" }, credit: "nickname", sharing: "private" };
    const r = applyChange(null, person, { actor: { type: "person", person: { reference: `Person/${id}` } }, permissions: [], now: o.now(), newId: o.newId });
    if (!r.ok) return c.json({ error: r.reasons }, 400);
    await o.store.commit(r.record, r.provenance);
    await o.linkAccount(caller.authUserId, r.record);
    return c.json(r.record, 201);
  });

  return app;
}

/** The public summary of a project or group (spec: "Publish as you are"). */
function summary(r: BixResource): BixResource {
  const keep = ["resourceType", "id", "meta", "title", "name", "kind", "status", "period", "location", "cause", "servesGroup", "organization", "image", "description"];
  return Object.fromEntries(Object.entries(r).filter(([k]) => keep.includes(k))) as BixResource;
}
