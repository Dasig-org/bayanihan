import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp, type ServerOptions } from "./app.js";
import { hashToken } from "./links.js";

/**
 * Starting Bayanihan Server.
 *
 * BIX_DB=/data/bix.db      SQLite (one file; Litestream backs it up). The hosted Dasig Ecosystem and self-hosters use this.
 * DATABASE_URL=postgres:// Postgres, the upgrade path (and the local development default).
 * BIX_PUBLIC_URL           This server's public address, e.g. https://ecosystem.dasig.org. Bound into every sign-up proof.
 * BIX_OPEN_JOIN=1          Accept sign-ups (GET /$challenge, POST /$join).
 * BIX_CORS_ORIGINS         Comma-separated web origins allowed to call it (the Dasig web app). Default: any.
 * BIX_DEV_HEADERS=1        Local testing only: trust an x-bix-person header. Refused when NODE_ENV=production.
 * BIX_TOKEN_DAYS=30        Phone tokens stop working after this many days; the app renews them by signing a challenge.
 * GOOGLE_CLIENT_IDS        Comma-separated Google OAuth client IDs whose ID tokens this server accepts (POST /$google).
 */
const env = process.env;
const production = env.NODE_ENV === "production";
const devHeaders = env.BIX_DEV_HEADERS === "1";
if (devHeaders && production) { console.error("BIX_DEV_HEADERS lets anyone act as anyone; it is refused in production."); process.exit(1); }
const corsOrigins = env.BIX_CORS_ORIGINS ? env.BIX_CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
const port = Number(env.PORT ?? 8787);
const common = { now: () => new Date().toISOString(), newId: randomUUID, ...(corsOrigins ? { corsOrigins } : {}) };

const tokenDays = Number(env.BIX_TOKEN_DAYS ?? 0);
/** Google ID tokens, checked against Google's published keys (cached by jose), for the given client IDs. */
async function googleVerifier(audience: string[]) {
  const { createRemoteJWKSet, jwtVerify } = await import("jose");
  const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  return async (idToken: string) => {
    const { payload } = await jwtVerify(idToken, jwks, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience });
    if (!payload.sub || payload["email_verified"] === false) return null;
    return { sub: String(payload.sub), ...(payload["email"] ? { email: String(payload["email"]) } : {}) };
  };
}

async function options(): Promise<ServerOptions> {
  if (env.BIX_DB) {
    const { sqliteStore } = await import("./sqlite-store.js");
    const { nodeSqlite } = await import("./node-sqlite.js");
    mkdirSync(dirname(env.BIX_DB), { recursive: true });
    const s = await sqliteStore(nodeSqlite(env.BIX_DB));
    return {
      ...common, store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, files: s.files, devices: s.devices,
      ...(env.GOOGLE_CLIENT_IDS ? { google: { identities: s.identities, verify: await googleVerifier(env.GOOGLE_CLIENT_IDS.split(",").map((x) => x.trim()).filter(Boolean)) } } : {}),
      ...(env.BIX_OPEN_JOIN === "1" ? { openJoin: { audience: env.BIX_PUBLIC_URL ?? `http://localhost:${port}`, perHour: Number(env.BIX_JOIN_PER_HOUR ?? 10) } } : {}),
      async identify(req) {
        if (devHeaders && req.headers.get("x-bix-person")) return { person: req.headers.get("x-bix-person") };
        const h = req.headers.get("authorization");
        return { person: h?.startsWith("Bearer ") ? await s.devices.personFor(await hashToken(h.slice(7)), tokenDays ? tokenDays * 86400000 : undefined) : null };
      },
    };
  }
  const { pgStore } = await import("./pg-store.js");
  const { verifyToken } = await import("./auth-jwt.js");
  const { pgKeys } = await import("./keys.js");
  const { pgSequences } = await import("./refs.js");
  const { diskFiles } = await import("./files-disk.js");
  const store = pgStore(env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres");
  const secret = env.SUPABASE_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long"; // local Supabase default
  return {
    ...common, store, keys: pgKeys(store.sql), sequences: pgSequences(store.sql), linkTokens: store.linkTokens,
    files: diskFiles(env.BIX_FILES_DIR ?? ".data/files", store.fileMeta),
    async identify(req) {
      if (devHeaders && req.headers.get("x-bix-person")) return { person: req.headers.get("x-bix-person") };
      const authUserId = await verifyToken(req, secret);
      if (!authUserId) return { person: null };
      return { person: await store.personForAccount(authUserId), authUserId };
    },
    linkAccount: (id, person) => store.linkAccount(id, person),
  };
}

const app = createApp(await options());
serve({ fetch: app.fetch, port, hostname: env.HOST ?? "0.0.0.0" }, (i) =>
  console.log(`Bayanihan Server on :${i.port} · ${env.BIX_DB ? `SQLite ${env.BIX_DB}` : "Postgres"}${env.BIX_OPEN_JOIN === "1" ? " · sign-ups open" : ""}${devHeaders ? " · dev headers ON" : ""}`));
