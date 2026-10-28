import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { pgStore } from "./pg-store.js";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const app = createApp({
  store: pgStore(url),
  // v0 local development only: trust an x-bix-person header. Replace with Supabase Auth before anything leaves this machine.
  async identify(req) {
    const p = req.headers.get("x-bix-person");
    if (!p) return null;
    const perms = (req.headers.get("x-bix-permissions") ?? "").split(",").filter(Boolean);
    return { actor: { type: "person", person: { reference: p } }, permissions: perms, newId: randomUUID };
  },
  now: () => new Date().toISOString(),
  newId: randomUUID,
});
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) }, (i) => console.log(`Bayanihan Server on http://localhost:${i.port}`));
