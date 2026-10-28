import { generateGroupKey } from "@bayanihan/core";

export type GroupKey = { keyId: string; privateKey: CryptoKey; publicKey: CryptoKey; publicJwk: JsonWebKey };
export interface KeyStore {
  /** The signing key for a group or person, created on first use. */
  keyFor(owner: string): Promise<GroupKey>;
  /** The public key only, for checking. */
  publicKeyFor(owner: string): Promise<{ keyId: string; publicJwk: JsonWebKey } | null>;
}

const importPub = (j: JsonWebKey) => crypto.subtle.importKey("jwk", j, { name: "Ed25519" }, true, ["verify"]);
const importPriv = (j: JsonWebKey) => crypto.subtle.importKey("jwk", j, { name: "Ed25519" }, false, ["sign"]);
export const importPublicJwk = importPub;

async function fresh(owner: string) {
  const k = await generateGroupKey();
  const publicJwk = await crypto.subtle.exportKey("jwk", k.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", k.privateKey);
  return { keyId: `${owner}#k1`, publicJwk, privateJwk };
}

export function memoryKeys(): KeyStore {
  const m = new Map<string, { keyId: string; publicJwk: JsonWebKey; privateJwk: JsonWebKey }>();
  return {
    async keyFor(owner) {
      if (!m.has(owner)) m.set(owner, await fresh(owner));
      const k = m.get(owner)!;
      return { keyId: k.keyId, publicJwk: k.publicJwk, publicKey: await importPub(k.publicJwk), privateKey: await importPriv(k.privateJwk) };
    },
    async publicKeyFor(owner) { const k = m.get(owner); return k ? { keyId: k.keyId, publicJwk: k.publicJwk } : null; },
  };
}

export function pgKeys(sql: import("postgres").Sql): KeyStore {
  return {
    async keyFor(owner) {
      let rows = await sql`select key_id, public_jwk, private_jwk from bix_keys where owner = ${owner}`;
      if (!rows.length) {
        const k = await fresh(owner);
        await sql`insert into bix_keys (owner, key_id, public_jwk, private_jwk) values (${owner}, ${k.keyId}, ${sql.json(k.publicJwk as never)}, ${sql.json(k.privateJwk as never)}) on conflict (owner) do nothing`;
        rows = await sql`select key_id, public_jwk, private_jwk from bix_keys where owner = ${owner}`;
      }
      const r = rows[0]!;
      return { keyId: r.key_id, publicJwk: r.public_jwk, publicKey: await importPub(r.public_jwk), privateKey: await importPriv(r.private_jwk) };
    },
    async publicKeyFor(owner) {
      const rows = await sql`select key_id, public_jwk from bix_keys where owner = ${owner}`;
      return rows[0] ? { keyId: rows[0].key_id, publicJwk: rows[0].public_jwk } : null;
    },
  };
}
