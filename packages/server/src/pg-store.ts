import postgres from "postgres";
import type { BixResource, Store } from "@bayanihan/core";

/** Postgres-backed store for Bayanihan Server. Tables: supabase/migrations/*_bix_records.sql */
export function pgStore(url: string) {
  const sql = postgres(url, { max: 5 });
  return {
    async get(type: string, id: string) {
      const rows = await sql`select resource from bix_records where type = ${type} and id = ${id}`;
      return (rows[0]?.resource as BixResource | undefined) ?? null;
    },
    /** Optimistic: refuses if someone else committed the same version first (rule 16). */
    async commit(record: BixResource, provenance: BixResource) {
      await sql.begin(async (tx) => {
        const v = record.meta.version;
        if (v === 1) {
          await tx`insert into bix_records (type, id, version, resource) values (${record.resourceType}, ${record.id}, 1, ${tx.json(record as never)})`;
        } else {
          const res = await tx`update bix_records set version = ${v}, resource = ${tx.json(record as never)}, updated_at = now()
                               where type = ${record.resourceType} and id = ${record.id} and version = ${v - 1}`;
          if (res.count !== 1) throw new Error("stale change: someone else got there first");
        }
        await tx`insert into bix_history (type, id, version, resource) values (${record.resourceType}, ${record.id}, ${v}, ${tx.json(record as never)})`;
        await tx`insert into bix_records (type, id, version, resource) values ('Provenance', ${provenance.id}, 1, ${tx.json(provenance as never)})`;
      });
    },
    async history(type: string, id: string) {
      const rows = await sql`select resource from bix_history where type = ${type} and id = ${id} order by version`;
      return rows.map((r) => r.resource as BixResource);
    },
    /** v0 search: equality on top-level string fields, or on a reference's target. */
    async search(type: string, params: Record<string, string>) {
      const conds = Object.entries(params).map(([k, v]) => k === "bayanihan:ref"
        ? sql`resource->'identifier' @> ${sql.json([{ system: k, value: v }] as never)}` :
        sql`(resource->>${k} = ${v} or resource->${k}->>'reference' = ${v})`);
      const where = conds.reduce((a, b) => sql`${a} and ${b}`, sql`type = ${type}`);
      const rows = await sql`select resource from bix_records where ${where} order by updated_at desc limit 200`;
      return rows.map((r) => r.resource as BixResource);
    },
    async personForAccount(authUserId: string) {
      const rows = await sql`select person_id from bix_accounts where auth_user_id = ${authUserId}`;
      return (rows[0]?.person_id as string | undefined) ?? null;
    },
    async linkAccount(authUserId: string, person: BixResource) {
      await sql`insert into bix_accounts (auth_user_id, person_id) values (${authUserId}, ${"Person/" + person.id})`;
    },
    /** Provenance records about one record, newest last. */
    async provenanceFor(target: string) {
      const rows = await sql`select resource from bix_records where type = 'Provenance'
        and (resource->'target' @> ${sql.json([{ reference: target }] as never)} or exists (
          select 1 from jsonb_array_elements(resource->'target') t where t->>'reference' like ${target + "/_history/%"}))
        order by resource->>'occurredAt'`;
      return rows.map((r) => r.resource as BixResource);
    },
    async version(type: string, id: string, version: number) {
      const rows = await sql`select resource from bix_history where type = ${type} and id = ${id} and version = ${version}`;
      return (rows[0]?.resource as BixResource | undefined) ?? null;
    },
    sql,
    end: () => sql.end(),
  } satisfies Store & Record<string, unknown>;
}
