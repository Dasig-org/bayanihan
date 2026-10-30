import type { BixResource } from "@bayanihan/core";

export const REF_SYSTEM = "bayanihan:ref";
export const PREFIX_SYSTEM = "bayanihan:ref-prefix";

export interface Sequences { next(prefix: string): Promise<number> }
export function memorySequences(): Sequences {
  const m = new Map<string, number>();
  return { async next(p) { const v = (m.get(p) ?? 0) + 1; m.set(p, v); return v; } };
}
export function pgSequences(sql: import("postgres").Sql): Sequences {
  return { async next(p) {
    const r = await sql`insert into bix_sequences (prefix, next) values (${p}, 2) on conflict (prefix) do update set next = bix_sequences.next + 1 returning next - 1 as n`;
    return Number(r[0]!.n);
  } };
}

/** The prefix for a project: its own `bayanihan:ref-prefix` identifier, or initials of its title ("Lahug Uplands Fun Run 2027" → "LU27"). */
export function prefixFor(initiative: BixResource): string {
  const set = ((initiative["identifier"] as { system?: string; value: string }[] | undefined) ?? []).find((i) => i.system === PREFIX_SYSTEM);
  if (set) return set.value.toUpperCase();
  const words = String(initiative["title"] ?? "X").split(/\s+/).filter(Boolean);
  const letters = words.filter((w) => !/^\d+$/.test(w)).map((w) => w[0]!.toUpperCase()).join("").slice(0, 4);
  const year = words.find((w) => /^\d{4}$/.test(w))?.slice(2) ?? "";
  return (letters || "X") + year;
}

/** Give a new record its short reference, unless it already has one. */
export function withRef(record: BixResource, ref: string): BixResource {
  const ids = (record["identifier"] as { system?: string; value: string }[] | undefined) ?? [];
  if (ids.some((i) => i.system === REF_SYSTEM)) return record;
  return { ...record, identifier: [...ids, { system: REF_SYSTEM, value: ref }] };
}
