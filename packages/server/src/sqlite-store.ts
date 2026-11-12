import type { BixResource, Store } from "@bayanihan/core";
import { generateGroupKey } from "@bayanihan/core";
import type { KeyStore } from "./keys.js";
import type { Sequences } from "./refs.js";
import type { LinkTokens } from "./links.js";
import { sha256hex, type FileMeta, type FileStore } from "./files.js";

/** The few SQLite calls the store needs. Adapters: expo-sqlite on the phone, node:sqlite in tests. */
export interface Db {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: (string | number | null)[]): Promise<{ changes: number }>;
  all<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
  tx<T>(fn: () => Promise<T>): Promise<T>;
}

const SCHEMA = `
create table if not exists bix_records (type text not null, id text not null, version integer not null, resource text not null, updated_at text not null, primary key (type, id));
create table if not exists bix_history (type text not null, id text not null, version integer not null, resource text not null, recorded_at text not null, primary key (type, id, version));
create trigger if not exists bix_history_no_update before update on bix_history begin select raise(abort, 'bix_history is append-only'); end;
create trigger if not exists bix_history_no_delete before delete on bix_history begin select raise(abort, 'bix_history is append-only'); end;
create table if not exists bix_keys (owner text primary key, key_id text not null, public_key text not null, private_key text not null);
create table if not exists bix_sequences (prefix text primary key, next integer not null);
create table if not exists bix_link_tokens (token_hash text primary key, link_id text not null);
create table if not exists bix_file_groups (hash text not null, org text not null, size integer not null, primary key (hash, org));
create table if not exists bix_files (hash text primary key, content_type text not null, size integer not null, uploaded_by text not null, shows_minors integer not null);
create table if not exists bix_file_bytes (hash text primary key, data text not null);
create table if not exists bix_devices (token_hash text primary key, person_id text not null, created_at text not null);
create table if not exists bix_push (device text not null, person_id text not null, kind text not null, target text not null, created_at text not null, primary key (device, kind));
create table if not exists bix_identities (provider text not null, subject text not null, person_id text not null, created_at text not null, primary key (provider, subject));
`;

/** Bayanihan Server's storage on SQLite: the same behaviour as the Postgres store, for a phone or a hub. */
export async function sqliteStore(db: Db) {
  await db.exec(SCHEMA);
  const now = () => new Date().toISOString();
  const parse = (rows: { resource: string }[]) => rows.map((r) => JSON.parse(r.resource) as BixResource);

  const store = {
    async get(type: string, id: string) {
      const r = await db.all<{ resource: string }>("select resource from bix_records where type = ? and id = ?", type, id);
      return r[0] ? (JSON.parse(r[0].resource) as BixResource) : null;
    },
    async commit(record: BixResource, provenance: BixResource) {
      await db.tx(async () => {
        const v = record.meta.version, json = JSON.stringify(record);
        if (v === 1) await db.run("insert into bix_records (type, id, version, resource, updated_at) values (?, ?, 1, ?, ?)", record.resourceType, record.id, json, now());
        else {
          const r = await db.run("update bix_records set version = ?, resource = ?, updated_at = ? where type = ? and id = ? and version = ?", v, json, now(), record.resourceType, record.id, v - 1);
          if (r.changes !== 1) throw new Error("stale change: someone else got there first");
        }
        await db.run("insert into bix_history (type, id, version, resource, recorded_at) values (?, ?, ?, ?, ?)", record.resourceType, record.id, v, json, now());
        await db.run("insert into bix_records (type, id, version, resource, updated_at) values ('Provenance', ?, 1, ?, ?)", provenance.id, JSON.stringify(provenance), now());
      });
    },
    /** Equality on top-level fields or reference targets; participant matches any active person. */
    async search(type: string, params: Record<string, string>) {
      let where = "type = ?"; const args: string[] = [type];
      for (const [k, v] of Object.entries(params)) {
        if (k === "bayanihan:ref") { where += " and exists (select 1 from json_each(resource, '$.identifier') i where json_extract(i.value, '$.system') = ? and json_extract(i.value, '$.value') = ?)"; args.push(k, v); }
        else if (k === "participant") { where += " and exists (select 1 from json_each(resource, '$.participant') p where json_extract(p.value, '$.person.reference') = ?)"; args.push(v); }
        else { where += ` and (json_extract(resource, ?) = ? or json_extract(resource, ?) = ?)`; args.push(`$."${k}"`, v, `$."${k}".reference`, v); }
      }
      return parse(await db.all<{ resource: string }>(`select resource from bix_records where ${where} order by updated_at asc limit 500`, ...args));
    },
    async history(type: string, id: string) {
      return parse(await db.all<{ resource: string }>("select resource from bix_history where type = ? and id = ? order by version", type, id));
    },
    async version(type: string, id: string, version: number) {
      const r = await db.all<{ resource: string }>("select resource from bix_history where type = ? and id = ? and version = ?", type, id, version);
      return r[0] ? (JSON.parse(r[0].resource) as BixResource) : null;
    },
    async provenanceFor(target: string) {
      return parse(await db.all<{ resource: string }>("select resource from bix_records where type = 'Provenance' and instr(resource, ?) > 0 order by json_extract(resource, '$.occurredAt')", `"${target}/_history/`));
    },
    async mentioning(reference: string) {
      return parse(await db.all<{ resource: string }>("select resource from bix_records where instr(resource, ?) > 0", reference.includes("/") ? `"${reference}` : reference));
    },
    /** Every record, for a hub-to-cloud or hub-to-phone copy. */
    async all() { return parse(await db.all<{ resource: string }>("select resource from bix_records")); },
  } satisfies Store & Record<string, unknown>;

  const keys: KeyStore = {
    async keyFor(owner) {
      let r = await db.all<{ key_id: string; public_key: string; private_key: string }>("select * from bix_keys where owner = ?", owner);
      if (!r[0]) { const k = await generateGroupKey(); await db.run("insert or ignore into bix_keys values (?, ?, ?, ?)", owner, `${owner}#k1`, k.publicKey, k.privateKey); r = await db.all("select * from bix_keys where owner = ?", owner); }
      return { keyId: r[0]!.key_id, publicKey: r[0]!.public_key, privateKey: r[0]!.private_key };
    },
    async publicKeyFor(owner) {
      const r = await db.all<{ key_id: string; public_key: string }>("select key_id, public_key from bix_keys where owner = ?", owner);
      return r[0] ? { keyId: r[0].key_id, publicKey: r[0].public_key } : null;
    },
  };
  const sequences: Sequences = {
    async next(prefix) {
      return db.tx(async () => {
        await db.run("insert or ignore into bix_sequences values (?, 1)", prefix);
        const r = await db.all<{ next: number }>("select next from bix_sequences where prefix = ?", prefix);
        await db.run("update bix_sequences set next = next + 1 where prefix = ?", prefix);
        return Number(r[0]!.next);
      });
    },
  };
  const linkTokens: LinkTokens = {
    async save(h, id) { await db.run("insert into bix_link_tokens values (?, ?)", h, id); },
    async find(h) { const r = await db.all<{ link_id: string }>("select link_id from bix_link_tokens where token_hash = ?", h); return r[0]?.link_id ?? null; },
  };
  const fileMeta = {
    async save(m: FileMeta) { await db.run("insert or ignore into bix_files values (?, ?, ?, ?, ?)", m.hash, m.contentType, m.size, m.uploadedBy, m.showsMinors ? 1 : 0); },
    async load(hash: string): Promise<FileMeta | null> {
      const r = await db.all<{ hash: string; content_type: string; size: number; uploaded_by: string; shows_minors: number }>("select * from bix_files where hash = ?", hash);
      return r[0] ? { hash: r[0].hash, contentType: r[0].content_type, size: r[0].size, uploadedBy: r[0].uploaded_by, showsMinors: !!r[0].shows_minors } : null;
    },
  };
  /** Phones paired with a hub: a token (only its hash stored) per phone, mapped to its Person. */
  const devices = {
    async save(tokenHash: string, person: string) { await db.run("insert into bix_devices values (?, ?, ?)", tokenHash, person, now()); },
    async forget(tokenHash: string) { await db.run("delete from bix_devices where token_hash = ?", tokenHash); },
    /** A token older than maxAgeMs no longer works (hosted servers renew them with the phone's key; hubs keep them). */
    async personFor(tokenHash: string, maxAgeMs?: number) {
      const r = await db.all<{ person_id: string; created_at: string }>("select person_id, created_at from bix_devices where token_hash = ?", tokenHash);
      if (!r[0]) return null;
      if (maxAgeMs && Date.now() - Date.parse(r[0].created_at) > maxAgeMs) return null;
      return r[0].person_id;
    },
  };
  const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  /** Files kept in the same database (a phone or hub has nowhere else it needs to manage). */
  const files: FileStore = {
    async put(bytes, m) {
      const hash = await sha256hex(bytes);
      await db.run("insert or ignore into bix_file_bytes values (?, ?)", hash, b64(bytes));
      const full = { ...m, hash, size: bytes.byteLength };
      await fileMeta.save(full);
      return (await fileMeta.load(hash)) ?? full;
    },
    async get(hash) {
      const meta = await fileMeta.load(hash);
      const r = await db.all<{ data: string }>("select data from bix_file_bytes where hash = ?", hash);
      return meta && r[0] ? { bytes: unb64(r[0].data), meta } : null;
    },
  };
  /** Outside sign-ins linked to a Person (e.g. Google), for getting back in on a new phone. */
  const identities = {
    async personFor(provider: string, subject: string) { const r = await db.all<{ person_id: string }>("select person_id from bix_identities where provider = ? and subject = ?", provider, subject); return r[0]?.person_id ?? null; },
    async link(provider: string, subject: string, person: string) { await db.run("insert or replace into bix_identities values (?, ?, ?, ?)", provider, subject, person, now()); },
  };
  /** Which group's storage each file counts against (a file shared by two groups counts once in each). */
  const groupFiles = {
    async add(hash: string, org: string, size: number) { await db.run("insert or ignore into bix_file_groups values (?, ?, ?)", hash, org, size); },
    async used(org: string) { const r = await db.all<{ n: number | null }>("select sum(size) as n from bix_file_groups where org = ?", org); return Number(r[0]?.n ?? 0); },
  };
  /** Where to send push notifications: one target per signed-in device and kind. Not BIX records; never synced. */
  const pushTargets = {
    async save(device: string, person: string, kind: "expo" | "web", target: string) { await db.run("insert or replace into bix_push values (?, ?, ?, ?, ?)", device, person, kind, target, now()); },
    async forPerson(person: string) { return (await db.all<{ device: string; kind: "expo" | "web"; target: string }>("select device, kind, target from bix_push where person_id = ?", person)); },
    async forgetDevice(device: string) { await db.run("delete from bix_push where device = ?", device); },
    async forgetPerson(person: string) { await db.run("delete from bix_push where person_id = ?", person); },
    async forgetTarget(target: string) { await db.run("delete from bix_push where target = ?", target); },
  };
  return { store, keys, sequences, linkTokens, fileMeta, files, devices, identities, groupFiles, pushTargets };
}
