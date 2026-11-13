import type { BixResource } from "@bayanihan/core";

/*
 * Push notifications. Delivery only: nothing here is a BIX record, and device targets are never synced, signed or
 * exported. A push says that something needs you, in general words, and opening it loads the detail in the app, so no
 * task text, place, child or group-only detail passes through Google, Apple or Expo.
 *
 * Who gets told is decided from the change itself (the same moments the app's Inbox shows):
 * - a Task asked of you (status becomes "requested" with you as owner)
 * - someone asks to join a group you run (a new Role with status "requested") — officers and core members
 * - someone asks to join a team you lead (a Team participant added as "requested") — the team's leads
 * - an Offer matched to a Need in a group you run — officers and core members
 */
export type PushKind = "expo" | "web";
export type PushTarget = { device: string; kind: PushKind; target: string };
export type PushTargets = {
  save(device: string, person: string, kind: PushKind, target: string): Promise<void>;
  forPerson(person: string): Promise<PushTarget[]>;
  forgetDevice(device: string): Promise<void>;
  forgetPerson(person: string): Promise<void>;
  forgetTarget(target: string): Promise<void>;
};
export type PushMessage = { title: string; body: string; url: string };
/** Returns the targets that are gone for good (uninstalled, unsubscribed), so they can be forgotten. */
export type PushSender = (targets: PushTarget[], m: PushMessage) => Promise<string[]>;
export type Push = { targets: PushTargets; send: Partial<Record<PushKind, PushSender>>; webPublicKey?: string };

type Get = (type: string, id: string) => Promise<BixResource | null>;
type Search = (type: string, params: Record<string, string>) => Promise<BixResource[]>;
const idOf = (ref?: string) => ref?.split("/")[1] ?? "";
const parts = (r: BixResource | null) => ((r?.participant ?? []) as { person?: { reference?: string }; role?: string; status?: string }[]);

async function leadsOf(search: Search, org: string): Promise<string[]> {
  const roles = await search("Role", { organization: org });
  return roles.filter((r) => r.status === "active" && ["officer", "core-member"].includes((r.code as { code?: string })?.code ?? "")).map((r) => (r.person as { reference: string }).reference);
}

/** The pushes a committed change causes. Never the person who made it. */
export async function pushesFor(prev: BixResource | null, rec: BixResource, actor: string, get: Get, search: Search): Promise<{ person: string; m: PushMessage }[]> {
  const out: { person: string; m: PushMessage }[] = [];
  const groupName = async (orgRef?: string) => (orgRef ? ((await get("Organization", idOf(orgRef)))?.name as string | undefined) : undefined) ?? "Your group";
  if (rec.resourceType === "Task") {
    const owner = (rec.owner as { reference?: string } | undefined)?.reference;
    const was = prev ? `${prev.status}|${(prev.owner as { reference?: string } | undefined)?.reference}` : "";
    if (rec.status === "requested" && owner?.startsWith("Person/") && was !== `requested|${owner}`) {
      const ini = await get("Initiative", idOf((rec.partOf as { reference?: string } | undefined)?.reference));
      const org = (ini?.organization as { reference?: string } | undefined)?.reference;
      out.push({ person: owner, m: { title: `${org ? await groupName(org) : "Someone"} asked you to help`, body: "Open Dasig to say yes or no.", url: `/task/${rec.id}` } });
    }
  }
  if (rec.resourceType === "Role" && !prev && rec.status === "requested") {
    const org = (rec.organization as { reference: string }).reference;
    const name = await groupName(org);
    for (const p of await leadsOf(search, org)) out.push({ person: p, m: { title: `Someone wants to join ${name}`, body: "Open Dasig to accept.", url: `/org/${idOf(org)}/people` } });
  }
  if (rec.resourceType === "Team") {
    const before = new Set(parts(prev).filter((p) => p.status === "requested").map((p) => p.person?.reference));
    const asking = parts(rec).filter((p) => p.status === "requested" && !before.has(p.person?.reference));
    if (asking.length) for (const l of parts(rec).filter((p) => p.role === "lead" && p.status === "active"))
      out.push({ person: l.person!.reference!, m: { title: `Someone wants to join ${rec.name as string}`, body: "Open Dasig to add them.", url: `/team/${rec.id}` } });
  }
  if (rec.resourceType === "Offer" && !prev) {
    // Offer.matchedTo is one Reference (BIX); accept a list too, from older records.
    const m = rec.matchedTo as { reference?: string } | { reference?: string }[] | undefined;
    const needRef = (Array.isArray(m) ? m[0] : m)?.reference;
    const need = needRef ? await get("Need", idOf(needRef)) : null;
    const ini = need ? await get("Initiative", idOf((need.initiative as { reference?: string } | undefined)?.reference)) : null;
    const org = (ini?.organization as { reference?: string } | undefined)?.reference;
    if (org) for (const p of await leadsOf(search, org)) out.push({ person: p, m: { title: "New offer of help", body: `For ${(ini!.title as string) ?? "a project"}. Open Dasig to accept.`, url: `/need/${need!.id}` } });
  }
  return out.filter((x) => x.person !== actor);
}

/** Send without ever holding up or failing the change that caused it. */
export function dispatch(push: Push | undefined, prev: BixResource | null, rec: BixResource, actor: string, get: Get, search: Search | undefined) {
  if (!push || !search) return;
  void (async () => {
    for (const { person, m } of await pushesFor(prev, rec, actor, get, search)) {
      const ts = await push.targets.forPerson(person);
      for (const kind of ["expo", "web"] as const) {
        const mine = ts.filter((t) => t.kind === kind);
        const send = push.send[kind];
        if (!mine.length || !send) continue;
        for (const gone of await send(mine, m).catch(() => [] as string[])) await push.targets.forgetTarget(gone);
      }
    }
  })().catch(() => {});
}
