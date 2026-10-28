import { Hono } from "hono";
import { applyChange, replay, resourceTypes, toBundle, authorize, type Store, type BixResource } from "@bayanihan/core";
import { loadDirectory, permissionsForRecord, type Caller } from "./auth.js";

export type ServerOptions = {
  store: Store & { search?(type: string, params: Record<string, string>): Promise<BixResource[]>; history?(type: string, id: string): Promise<BixResource[]> };
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

  app.get("/:type/:id/_history", async (c) => {
    const { type, id } = c.req.param();
    if (!o.store.history) return c.json({ error: "history not supported by this store" }, 501);
    return c.json(toBundle(await o.store.history(type, id), "export", o.newId(), o.now()));
  });

  app.get("/:type/:id", async (c) => {
    const { type, id } = c.req.param();
    if (!resourceTypes.includes(type)) return c.json({ error: `unknown type ${type}` }, 404);
    const r = await o.store.get(type, id);
    if (!r) return c.json({ error: "not found" }, 404);
    const me = (await o.identify(c.req.raw)).person;
    const dir = await loadDirectory(o.store, me, r);
    if (authorize(me, "view", r, dir).allowed) return c.json(r);
    if (authorize(me, "view-summary", r, dir).allowed && (type === "Initiative" || type === "Organization")) return c.json(summary(r));
    return c.json({ error: "not found" }, 404); // never reveal that a private record exists
  });

  app.get("/:type", async (c) => {
    const type = c.req.param("type");
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
        const r = applyChange(prev, e.resource, { ...(await ctxFor(e.resource)), now: o.now() });
        if (r.ok) await o.store.commit(r.record, r.provenance);
        results.push(r.ok ? { ok: true, record: r.record } : { ok: false, reasons: r.reasons, current: prev });
      }
      return c.json({ resourceType: "Bundle", type: "transaction-response", entry: results }, results.every((r) => r.ok) ? 200 : 409);
    }
    if (bundle.type === "sync") {
      const changes = [];
      for (const e of entries) changes.push({ record: e.resource, occurredAt: e.occurredAt ?? o.now(), context: await ctxFor(e.resource) });
      const out = await replay(o.store, changes, o.now());
      return c.json({ resourceType: "Bundle", type: "sync-response", accepted: out.accepted.map((a) => a.record), refused: out.refused });
    }
    return c.json({ error: "Bundle.type must be transaction or sync" }, 400);
  });

  /** First sign-in: create the caller's Person (nickname is enough) and link the account. */
  app.post("/$me", async (c) => {
    const caller = await o.identify(c.req.raw);
    if (!caller.authUserId) return c.json({ error: "sign in first" }, 401);
    if (caller.person) return c.json(await o.store.get("Person", caller.person.split("/")[1]!));
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
