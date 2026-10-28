import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { pgStore } from "./pg-store.js";
import { verifyToken } from "./auth-jwt.js";
import { pgKeys } from "./keys.js";
import { pgSequences } from "./refs.js";
import { diskFiles } from "./files-disk.js";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const secret = process.env.SUPABASE_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long"; // local Supabase default
const devHeaders = process.env.BIX_DEV_HEADERS === "1"; // local testing only: trust x-bix-person
const store = pgStore(url);

const app = createApp({
  store,
  keys: pgKeys(store.sql),
  sequences: pgSequences(store.sql),
  linkTokens: store.linkTokens,
  files: diskFiles(process.env.BIX_FILES_DIR ?? ".data/files", store.fileMeta),
  async identify(req) {
    if (devHeaders && req.headers.get("x-bix-person")) return { person: req.headers.get("x-bix-person") };
    const authUserId = await verifyToken(req, secret);
    if (!authUserId) return { person: null };
    return { person: await store.personForAccount(authUserId), authUserId };
  },
  linkAccount: (id, person) => store.linkAccount(id, person),
  now: () => new Date().toISOString(),
  newId: randomUUID,
});
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) }, (i) =>
  console.log(`Bayanihan Server on http://localhost:${i.port}${devHeaders ? " (dev headers ON)" : ""}`));
