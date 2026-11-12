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
const common = { places, now: () => new Date().toISOString(), newId: randomUUID, ...(corsOrigins ? { corsOrigins } : {}) };

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

/**
 * OIDC providers, from BIX_OIDC_PROVIDERS: "name|issuer|clientId,clientId;name2|…". Keys come from the issuer's
 * discovery document (jwks_uri), cached by jose. Example: dasig|https://turvwsqyusqixhjhvhhy.supabase.co/auth/v1|<id>,<id>
 */
async function oidcProviders(spec: string) {
  const { createRemoteJWKSet, jwtVerify } = await import("jose");
  const out: Record<string, { verify(t: string): Promise<{ sub: string; name?: string } | null> }> = {};
  for (const entry of spec.split(";").map((x) => x.trim()).filter(Boolean)) {
    const [name, issuer, ids] = entry.split("|");
    if (!name || !issuer || !ids) throw new Error(`BIX_OIDC_PROVIDERS: "${entry}" needs name|issuer|clientIds`);
    const meta = (await (await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`)).json()) as { jwks_uri: string };
    const jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
    const audience = ids.split(",").map((x) => x.trim()).filter(Boolean);
    out[name] = { async verify(t) {
      const { payload } = await jwtVerify(t, jwks, { issuer, audience });
      if (!payload.sub) return null;
      const n = payload["name"] ?? payload["given_name"] ?? (payload["user_metadata"] as { full_name?: string } | undefined)?.full_name;
      return { sub: String(payload.sub), ...(n ? { name: String(n) } : {}) };
    } };
  }
  return out;
}

/** The PSGC place list, read once on first use (data/psgc.json; credits in data/PSGC_NOTICE.md). */
let placesCache: ReturnType<typeof import("./places.js").placesIndex> | null = null;
async function places() {
  if (!placesCache) { const { readFileSync } = await import("node:fs"); const { placesIndex } = await import("./places.js");
    placesCache = placesIndex(JSON.parse(readFileSync(new URL("../data/psgc.json", import.meta.url), "utf8"))); }
  return placesCache;
}

async function options(): Promise<ServerOptions> {
  if (env.BIX_DB) {
    const { sqliteStore } = await import("./sqlite-store.js");
    const { nodeSqlite } = await import("./node-sqlite.js");
    mkdirSync(dirname(env.BIX_DB), { recursive: true });
    const s = await sqliteStore(nodeSqlite(env.BIX_DB));
    // Files in S3-compatible storage when configured (BIX_FILES_S3_BUCKET); files already in the database stay readable.
    if (env.BIX_FILES_S3_BUCKET) {
      const { s3Files, awsS3 } = await import("./files-s3.js");
      s.files = s3Files(await awsS3(env.BIX_FILES_S3_BUCKET, env.BIX_FILES_S3_REGION ?? env.AWS_REGION ?? "ap-southeast-1", env.BIX_FILES_S3_ENDPOINT,
        env.BIX_FILES_S3_ACCESS_KEY_ID && env.BIX_FILES_S3_SECRET_ACCESS_KEY ? { accessKeyId: env.BIX_FILES_S3_ACCESS_KEY_ID, secretAccessKey: env.BIX_FILES_S3_SECRET_ACCESS_KEY } : undefined), env.BIX_FILES_S3_PREFIX ?? "files/", s.fileMeta, s.files);
    }
    return {
      ...common, store: s.store, keys: s.keys, sequences: s.sequences, linkTokens: s.linkTokens, files: s.files, devices: s.devices,
      ...(env.GOOGLE_CLIENT_IDS ? { google: { identities: s.identities, verify: await googleVerifier(env.GOOGLE_CLIENT_IDS.split(",").map((x) => x.trim()).filter(Boolean)) } } : {}),
      // Push: web push with this server's VAPID keys; Expo (Dasig's Android app) when BIX_PUSH_EXPO=1. Keys live in env only.
      ...(env.BIX_PUSH_VAPID_PUBLIC || env.BIX_PUSH_EXPO === "1" ? { push: { targets: s.pushTargets, webPublicKey: env.BIX_PUSH_VAPID_PUBLIC, send: {
        ...(env.BIX_PUSH_VAPID_PUBLIC && env.BIX_PUSH_VAPID_PRIVATE ? { web: await (await import("./push.js")).webPushSender({ publicKey: env.BIX_PUSH_VAPID_PUBLIC, privateKey: env.BIX_PUSH_VAPID_PRIVATE, subject: env.BIX_PUSH_SUBJECT ?? "mailto:hello@example.org" }) } : {}),
        ...(env.BIX_PUSH_EXPO === "1" ? { expo: (await import("./push.js")).expoSender(env.BIX_PUSH_EXPO_TOKEN) } : {}) } } } : {}),
      ...(env.BIX_GROUP_STORAGE_BYTES ? { storage: { perGroupBytes: Number(env.BIX_GROUP_STORAGE_BYTES), groups: s.groupFiles } } : {}),
      ...(env.BIX_OIDC_PROVIDERS ? { oidc: { identities: s.identities, providers: await oidcProviders(env.BIX_OIDC_PROVIDERS) } } : {}),
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
