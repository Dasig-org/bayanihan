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
create table if not exists bix_email_codes (email text primary key, code_hash text not null, expires_at text not null, tries integer not null, sent_at text not null);
create table if not exists bix_handles (value text primary key, person_id text not null, released_at text);
create table if not exists bix_invite_emails (invitation_id text primary key, email_hash text not null, created_at text not null);
create table if not exists bix_invite_blocks (person_id text not null, org text not null, primary key (person_id, org));
create table if not exists bix_push (device text not null, person_id text not null, kind text not null, target text not null, created_at text not null, primary key (device, kind));
create table if not exists bix_identities (provider text not null, subject text not null, person_id text not null, created_at text not null, primary key (provider, subject));
`;

/** Bayanihan Server's storage on SQLite: the same behaviour as the Postgres store, for a phone or a hub. */
export async function sqliteStore(db: Db) {
  await db.exec(SCHEMA);
  // Columns added 2026-11-12 (sign-in methods and devices in Settings). SQLite has no "add column if not exists".
  for (const sql of ["alter table bix_identities add column label text", "alter table bix_devices add column via text", "alter table bix_devices add column name text"])
    await db.exec(sql).catch(() => {});
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
    /**
     * A hub taking a group handed over by the cloud (BIX "Taking a group to a hub and back"): records are kept as they
     * are, at their own versions, never as new versions. Only a newer version replaces what's here.
     */
    async keep(records: BixResource[]) {
      await db.tx(async () => {
        for (const r of records) {
          const json = JSON.stringify(r), v = r.meta.version;
          if (r.resourceType === "Provenance") { await db.run("insert or ignore into bix_records (type, id, version, resource, updated_at) values ('Provenance', ?, 1, ?, ?)", r.id, json, now()); continue; }
          const here = await db.all<{ version: number }>("select version from bix_records where type = ? and id = ?", r.resourceType, r.id);
          if (here[0] && here[0].version >= v) continue;
          await db.run("insert or replace into bix_records (type, id, version, resource, updated_at) values (?, ?, ?, ?, ?)", r.resourceType, r.id, v, json, now());
          await db.run("insert or ignore into bix_history (type, id, version, resource, recorded_at) values (?, ?, ?, ?, ?)", r.resourceType, r.id, v, json, now());
        }
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
      return parse(await db.all<{ resource: string }>(`select resource from (select resource, updated_at from bix_records where ${where} order by updated_at desc limit 1000) order by updated_at asc`, ...args));
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
    async save(tokenHash: string, person: string, meta: { via?: string; name?: string } = {}) {
      await db.run("insert into bix_devices (token_hash, person_id, created_at, via, name) values (?, ?, ?, ?, ?)", tokenHash, person, now(), meta.via ?? null, meta.name ?? null);
    },
    /** Signed-in phones and browsers for Settings. The id is a short slice of the token's hash, never the token. */
    async list(person: string) {
      return (await db.all<{ token_hash: string; created_at: string; via: string | null; name: string | null }>("select token_hash, created_at, via, name from bix_devices where person_id = ? order by created_at desc", person))
        .map((r) => ({ id: r.token_hash.slice(0, 16), created: r.created_at, via: r.via, name: r.name, hash: r.token_hash }));
    },
    async forgetId(person: string, id: string) {
      const r = await db.all<{ token_hash: string }>("select token_hash from bix_devices where person_id = ? and substr(token_hash, 1, 16) = ?", person, id);
      for (const x of r) await db.run("delete from bix_devices where token_hash = ?", x.token_hash);
      return r.map((x) => x.token_hash);
    },
    async viaFor(tokenHash: string) { return (await db.all<{ via: string | null }>("select via from bix_devices where token_hash = ?", tokenHash))[0]?.via ?? null; },
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
    async link(provider: string, subject: string, person: string, label?: string) { await db.run("insert or replace into bix_identities (provider, subject, person_id, created_at, label) values (?, ?, ?, ?, ?)", provider, subject, person, now(), label ?? null); },
    /** Refresh the email shown for a method (it can change at Google), without moving it. */
    async relabel(provider: string, subject: string, label: string) { await db.run("update bix_identities set label = ? where provider = ? and subject = ?", label, provider, subject); },
    async list(person: string) { return db.all<{ provider: string; subject: string; label: string | null; created_at: string }>("select provider, subject, label, created_at from bix_identities where person_id = ? order by created_at", person); },
    async unlink(provider: string, subject: string, person: string) { await db.run("delete from bix_identities where provider = ? and subject = ? and person_id = ?", provider, subject, person); },
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
  /** Email sign-in codes: only a hash is kept, with an expiry and a count of wrong tries. */
  const emailCodes = {
    async save(email: string, codeHash: string, expiresAt: string) { await db.run("insert or replace into bix_email_codes values (?, ?, ?, 0, ?)", email, codeHash, expiresAt, now()); },
    async get(email: string) { const r = await db.all<{ code_hash: string; expires_at: string; tries: number; sent_at: string }>("select * from bix_email_codes where email = ?", email); return r[0] ? { codeHash: r[0].code_hash, expiresAt: r[0].expires_at, tries: r[0].tries, sentAt: r[0].sent_at } : null; },
    async tried(email: string) { await db.run("update bix_email_codes set tries = tries + 1 where email = ?", email); },
    async clear(email: string) { await db.run("delete from bix_email_codes where email = ?", email); },
  };
  /** Usernames and invitations (src/invites.ts). Emails only as salted hashes, removed once matched. */
  const invites = {
    async handleOwner(value: string) { const r = await db.all<{ person_id: string; released_at: string | null }>("select person_id, released_at from bix_handles where value = ?", value); return r[0] ? { person: r[0].person_id, releasedAt: r[0].released_at } : null; },
    async setHandle(value: string, person: string) { await db.run("insert or replace into bix_handles values (?, ?, null)", value, person); },
    async releaseHandle(value: string, at: string) { await db.run("update bix_handles set released_at = ? where value = ?", at, value); },
    async saveEmail(invitation: string, hash: string) { await db.run("insert or replace into bix_invite_emails values (?, ?, ?)", invitation, hash, now()); },
    async invitationsForHashes(hashes: string[]) { if (!hashes.length) return []; return (await db.all<{ invitation_id: string }>(`select invitation_id from bix_invite_emails where email_hash in (${hashes.map(() => "?").join(",")})`, ...hashes)).map((r) => r.invitation_id); },
    async forgetEmail(invitation: string) { await db.run("delete from bix_invite_emails where invitation_id = ?", invitation); },
    async block(person: string, org: string) { await db.run("insert or ignore into bix_invite_blocks values (?, ?)", person, org); },
    async blocked(person: string, org: string) { return (await db.all("select 1 from bix_invite_blocks where person_id = ? and org = ?", person, org)).length > 0; },
  };
  return { store, keys, sequences, linkTokens, fileMeta, files, devices, identities, groupFiles, pushTargets, emailCodes, invites };
}
