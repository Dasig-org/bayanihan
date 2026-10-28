import { permissionsFor, owningParty, type BixResource, type Directory } from "@bayanihan/core";

export type Caller = { person: string | null; authUserId?: string };

type Searchable = { search?(type: string, params: Record<string, string>): Promise<BixResource[]>; get(type: string, id: string): Promise<BixResource | null> };
const ref = (x: unknown) => (x as { reference?: string } | undefined)?.reference;
const split = (r?: string) => (r ? (r.split("/") as [string, string]) : null);

/** Load what Core needs to decide access to one record: the owning group's roles, teams, positions and the project. */
export async function loadDirectory(store: Searchable, person: string | null, record: BixResource): Promise<Directory> {
  const dir: Directory = { roles: [], positions: [], teams: [], initiatives: [] };
  const add = async (type: "Team" | "Initiative", r?: string) => {
    const s = split(r); if (!s || s[0] !== type) return;
    const x = await store.get(type, s[1]); if (x) (type === "Team" ? dir.teams : dir.initiatives).push(x);
  };
  if (record.resourceType === "Team") dir.teams.push(record);
  if (record.resourceType === "Initiative") dir.initiatives.push(record);
  await add("Team", ref(record["team"]));
  await add("Team", ref(record["owner"]));
  for (const t of [...dir.teams]) await add("Initiative", ref(t["initiative"]));
  await add("Initiative", ref(record["initiative"]) ?? ref(record["partOf"]));
  const ini = dir.initiatives[0];
  if (ini && store.search) dir.teams.push(...(await store.search("Team", { initiative: `Initiative/${ini.id}` })).filter((t) => !dir.teams.some((x) => x.id === t.id)));
  if (person && store.search) {
    dir.roles = await store.search("Role", { person });
    const posIds = dir.roles.map((r) => split(ref(r["position"]))?.[1]).filter(Boolean) as string[];
    for (const id of posIds) { const p = await store.get("Position", id); if (p) dir.positions.push(p); }
  }
  return dir;
}

/** Permissions the caller holds for this record, from the group that owns it. Never across groups. */
export function permissionsForRecord(person: string | null, record: BixResource, dir: Directory): string[] {
  if (!person) return [];
  const o = owningParty(record, dir);
  const p = [...permissionsFor(person, o.organization, o.team, dir)];
  if (ref(record["reviewer"]) === person) p.push("reviewer");
  if (o.person === person) p.push("task.assign", "task.confirm", "initiative.plan");
  return p;
}
