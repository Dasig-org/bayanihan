import { Hono } from "hono";
import { applyChange, replay, resourceTypes, toBundle, type Store, type Change, type BixResource } from "@bayanihan/core";

export type ServerOptions = {
  store: Store & { search?(type: string, params: Record<string, string>): Promise<BixResource[]>; history?(type: string, id: string): Promise<BixResource[]> };
  /** Who is calling, and what they may do. v0: resolved by the caller's auth layer (Supabase Auth); see authorize() in Core. */
  identify(req: Request): Promise<Change["context"] | null>;
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
    return r ? c.json(r) : c.json({ error: "not found" }, 404);
  });

  app.get("/:type", async (c) => {
    const type = c.req.param("type");
    if (!resourceTypes.includes(type)) return c.json({ error: `unknown type ${type}` }, 404);
    if (!o.store.search) return c.json({ error: "search not supported by this store" }, 501);
    return c.json(toBundle(await o.store.search(type, c.req.query()), "export", o.newId(), o.now()));
  });

  /** POST a Bundle. "transaction": one change, applied now. "sync": offline changes, replayed in order. */
  app.post("/", async (c) => {
    const who = await o.identify(c.req.raw);
    if (!who) return c.json({ error: "sign in, or use a link" }, 401);
    const bundle = (await c.req.json()) as { type?: string; entry?: { resource: BixResource; occurredAt?: string }[] };
    const entries = bundle.entry ?? [];
    if (bundle.type === "transaction") {
      const results = [];
      for (const e of entries) {
        const prev = await o.store.get(e.resource.resourceType, e.resource.id);
        const r = applyChange(prev, e.resource, { ...who, now: o.now() });
        if (r.ok) await o.store.commit(r.record, r.provenance);
        results.push(r.ok ? { ok: true, record: r.record } : { ok: false, reasons: r.reasons, current: prev });
      }
      return c.json({ resourceType: "Bundle", type: "transaction-response", entry: results }, results.every((r) => r.ok) ? 200 : 409);
    }
    if (bundle.type === "sync") {
      const out = await replay(o.store, entries.map((e) => ({ record: e.resource, occurredAt: e.occurredAt ?? o.now(), context: who })), o.now());
      return c.json({ resourceType: "Bundle", type: "sync-response", accepted: out.accepted.map((a) => a.record), refused: out.refused });
    }
    return c.json({ error: "Bundle.type must be transaction or sync" }, 400);
  });

  return app;
}
