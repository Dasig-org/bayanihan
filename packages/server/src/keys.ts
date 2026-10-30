import { generateGroupKey } from "@bayanihan/core";

/** A group's signing key, hex-encoded Ed25519. The private key never leaves the server or hub. */
export type GroupKey = { keyId: string; privateKey: string; publicKey: string };
export interface KeyStore {
  keyFor(owner: string): Promise<GroupKey>;
  publicKeyFor(owner: string): Promise<{ keyId: string; publicKey: string } | null>;
}

export function memoryKeys(): KeyStore {
  const m = new Map<string, GroupKey>();
  return {
    async keyFor(owner) { if (!m.has(owner)) m.set(owner, { keyId: `${owner}#k1`, ...(await generateGroupKey()) }); return m.get(owner)!; },
    async publicKeyFor(owner) { const k = m.get(owner); return k ? { keyId: k.keyId, publicKey: k.publicKey } : null; },
  };
}

/** Keys in any SQL-ish table: (owner, key_id, public_jwk, private_jwk) columns now hold hex strings. */
export function pgKeys(sql: import("postgres").Sql): KeyStore {
  return {
    async keyFor(owner) {
      let rows = await sql`select key_id, public_jwk, private_jwk from bix_keys where owner = ${owner}`;
      if (!rows.length || typeof rows[0]!.public_jwk !== "string") {
        const k = await generateGroupKey();
        await sql`insert into bix_keys (owner, key_id, public_jwk, private_jwk) values (${owner}, ${owner + "#k2"}, ${sql.json(k.publicKey as never)}, ${sql.json(k.privateKey as never)})
                  on conflict (owner) do update set key_id = excluded.key_id, public_jwk = excluded.public_jwk, private_jwk = excluded.private_jwk`;
        rows = await sql`select key_id, public_jwk, private_jwk from bix_keys where owner = ${owner}`;
      }
      const r = rows[0]!;
      return { keyId: r.key_id, publicKey: r.public_jwk, privateKey: r.private_jwk };
    },
    async publicKeyFor(owner) {
      const rows = await sql`select key_id, public_jwk from bix_keys where owner = ${owner}`;
      return rows[0] && typeof rows[0].public_jwk === "string" ? { keyId: rows[0].key_id, publicKey: rows[0].public_jwk } : null;
    },
  };
}
