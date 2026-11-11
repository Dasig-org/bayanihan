import type { BixResource } from "./validate.js";

type Ref = { reference: string };
export type Action = "view" | "view-summary" | "edit" | "claim" | "propose" | "comment" | "assign" | "confirm" | "plan" | "manage-members" | "submit-report" | "vote";

/** What the caller has loaded about the people and groups involved. Core never fetches. */
export type Directory = {
  roles: BixResource[];      // Role records
  positions: BixResource[];  // Position records
  teams: BixResource[];      // Team records
  initiatives: BixResource[];// Initiative records (for owner org, partners, personal owner)
};

/** Default permissions by Role code (spec, "Value sets"). */
export const DEFAULT_PERMISSIONS: Record<string, string[]> = {
  officer: ["org.manage", "member.manage", "initiative.plan", "task.assign", "task.confirm", "report.submit"],
  "core-member": ["initiative.plan", "task.assign", "task.confirm"],
};

/**
 * Who's who (BIX Role.code). Everyone may be a volunteer in spirit, but organizationally the core team runs the group
 * and volunteers help with parts of it. Core team: officer, core-member, member. Everyone else (volunteer-regular,
 * volunteer-episodic, service-learning, partner-representative, donor) is outside the core team.
 */
export const CORE_TEAM_ROLES = ["officer", "core-member", "member"] as const;
/** Roles that see all of the group's work by default. Anyone else can be given `view.organization`. */
const SEES_ALL_ROLES = ["officer", "core-member"];
export const isCoreTeam = (code?: string) => (CORE_TEAM_ROLES as readonly string[]).includes(code ?? "");

const refOf = (r: BixResource) => `${r.resourceType}/${r.id}`;
const ref = (x: unknown) => (x as Ref | undefined)?.reference;
const active = (r: BixResource) => r["status"] === "active";

/** The Organization or Person that owns a record, following Task → Team / Initiative. */
export function owningParty(record: BixResource, dir: Directory): { organization?: string; person?: string; initiative?: string; team?: string } {
  if (record.resourceType === "Organization") return { organization: refOf(record) };
  if (record.resourceType === "Person") return { person: refOf(record), organization: ref(record["managedBy"])?.startsWith("Organization/") ? ref(record["managedBy"]) : undefined };
  if (record.resourceType === "Initiative") return { organization: ref(record["organization"]), person: ref(record["person"]), initiative: refOf(record) };
  // A Report belongs to the group that owes it (owedBy), about the project in its scope.
  if (record.resourceType === "Report") {
    const by = ref(record["owedBy"]); const ini = ((record["scope"] as { initiative?: Ref[] } | undefined)?.initiative ?? [])[0]?.reference;
    return { organization: by?.startsWith("Organization/") ? by : undefined, person: by?.startsWith("Person/") ? by : undefined, ...(ini ? { initiative: ini } : {}) };
  }
  if (record.resourceType === "Team") {
    const ini = dir.initiatives.find((i) => refOf(i) === ref(record["initiative"]));
    return { organization: ref(record["organization"]), initiative: ini ? refOf(ini) : undefined, team: refOf(record) };
  }
  const owner = ref(record["owner"]);
  const teamRef = ref(record["team"]) ?? (owner?.startsWith("Team/") ? owner : undefined);
  const team = teamRef ? dir.teams.find((t) => refOf(t) === teamRef) : undefined;
  if (team) return { ...owningParty(team, dir), team: refOf(team) };
  const iniRef = ref(record["initiative"]) ?? ref(record["partOf"]);
  const ini = dir.initiatives.find((i) => refOf(i) === iniRef);
  if (ini) return owningParty(ini, dir);
  if (owner?.startsWith("Organization/")) return { organization: owner };
  if (owner?.startsWith("Person/")) return { person: owner };
  return { organization: ref(record["organization"]) };
}

/** BIX permissions a person holds for one organization, and for one team in it. Never across groups. */
export function permissionsFor(person: string, organization: string | undefined, team: string | undefined, dir: Directory): Set<string> {
  const out = new Set<string>();
  if (!organization) return out;
  for (const role of dir.roles.filter((r) => ref(r["person"]) === person && ref(r["organization"]) === organization && active(r))) {
    const code = (role["code"] as { code?: string } | undefined)?.code ?? "";
    for (const p of DEFAULT_PERMISSIONS[code] ?? []) out.add(p);
    for (const p of (role["permissions"] as { code: string }[] | undefined) ?? []) out.add(p.code);
    const pos = dir.positions.find((x) => refOf(x) === ref(role["position"]));
    for (const p of (pos?.["permissions"] as { code: string }[] | undefined) ?? []) out.add(p.code);
    out.add("member");
    if (isCoreTeam(code)) out.add("core-team");
    if (SEES_ALL_ROLES.includes(code)) out.add("view.organization");
  }
  if (out.has("org.manage")) out.add("view.organization");
  if (team) {
    const t = dir.teams.find((x) => refOf(x) === team);
    const me = ((t?.["participant"] as { person: Ref; role: string; status: string }[] | undefined) ?? []).find((p) => p.person.reference === person && p.status === "active");
    if (me) {
      out.add("team.member");
      if (me.role === "lead") { out.add("task.assign"); out.add("task.confirm"); }
    }
  }
  return out;
}

const onTeamWithInitiativeAccess = (person: string, initiative: string | undefined, dir: Directory) =>
  !!initiative && dir.teams.some((t) => ref(t["initiative"]) === initiative && t["access"] === "initiative" &&
    ((t["participant"] as { person: Ref; status: string }[] | undefined) ?? []).some((p) => p.person.reference === person && p.status === "active"));

const isPartnerMember = (person: string, initiative: string | undefined, dir: Directory) => {
  const ini = dir.initiatives.find((i) => refOf(i) === initiative);
  const partners = ((ini?.["partner"] as Ref[] | undefined) ?? []).map((p) => p.reference);
  return dir.roles.some((r) => ref(r["person"]) === person && active(r) && partners.includes(ref(r["organization"]) ?? ""));
};

const onTeam = (t: BixResource | undefined, person: string) =>
  ((t?.["participant"] as { person: Ref; status: string }[] | undefined) ?? []).some((p) => p.person.reference === person && p.status === "active");

/**
 * Inside a group, how far a person sees work shared at `organization` (BIX "Seeing other committees' work"):
 * officers, core members and anyone given `view.organization` see everything; members see every committee in the
 * projects they're on, unless a committee keeps its work to itself (`Team.visibility: team`); volunteers see their
 * own committees, work offered to the whole group or to outsiders, and more only through `Team.access: initiative`.
 * Records that don't belong to a project or committee (the group itself, roles, positions) are seen by every member.
 */
function seesWithinGroup(person: string, record: BixResource, owner: ReturnType<typeof owningParty>, perms: Set<string>, dir: Directory): boolean {
  if (!owner.initiative && !owner.team) return true;
  if (perms.has("view.organization") || involves(person, record) || onTeamWithInitiativeAccess(person, owner.initiative, dir)) return true;
  const team = owner.team ? dir.teams.find((t) => refOf(t) === owner.team) : undefined;
  if (team && onTeam(team, person)) return true;
  if (record.resourceType === "Task" && ["organization", "open"].includes(String(record["audience"]))) return true;
  const inProject = !!owner.initiative && dir.teams.some((t) => ref(t["initiative"]) === owner.initiative && onTeam(t, person));
  if (record.resourceType === "Initiative") return inProject || perms.has("core-team");
  if (!perms.has("core-team")) return false;
  if (team?.["visibility"] === "team") return false;
  return inProject;
}

const involves = (person: string, record: BixResource) =>
  ref(record["owner"]) === person || ref(record["person"]) === person ||
  ((record["participant"] as { person: Ref }[] | undefined) ?? []).some((p) => p.person.reference === person);

export type ShareGrant = { grants: string[]; status: string; blocked?: Ref[] };

/**
 * May this person (or an anonymous visitor, person = null) do this to this record?
 * Decided from the owning group's Roles, Positions and Teams, the record's sharing level,
 * and any ShareLink presented. Returns a reason when refused.
 */
export function authorize(person: string | null, action: Action, record: BixResource, dir: Directory, link?: ShareGrant): { allowed: boolean; reason?: string } {
  const no = (reason: string) => ({ allowed: false, reason });
  const yes = { allowed: true };
  const owner = owningParty(record, dir);
  const sharing = (record["sharing"] as string | undefined) ?? "organization";

  // Public summaries (projects and groups) are readable by anyone when published.
  if (action === "view-summary") return record["publicSummary"] !== false || sharing === "public" ? yes : no("not published");

  // Personal work: only the person and people they added.
  if (owner.person && !owner.organization) {
    if (person && (owner.person === person || involves(person, record))) return yes;
    if (action === "view" && sharing === "public") return yes;
    return no("personal work belongs to its person");
  }

  const perms = person ? permissionsFor(person, owner.organization, owner.team, dir) : new Set<string>();
  const member = perms.has("member");

  // A share link can let someone in for what it grants, never beyond the record's sharing.
  const viaLink = !!link && link.status === "active" && !(person && (link.blocked ?? []).some((b) => b.reference === person));
  const linkAllows = (g: string) => viaLink && link!.grants.includes(g);

  const canView =
    sharing === "public" || (member && (sharing !== "organization" || seesWithinGroup(person!, record, owner, perms, dir))) || linkAllows("view") ||
    (person !== null && (involves(person, record) || onTeamWithInitiativeAccess(person, owner.initiative, dir))) ||
    (sharing === "partners" && person !== null && isPartnerMember(person, owner.initiative, dir)) ||
    (sharing === "network" && person !== null);
  if (sharing === "private" && !(person && (involves(person, record) || perms.has("task.assign") || perms.has("org.manage")))) {
    return action === "view" ? no("private") : no("private");
  }

  switch (action) {
    case "view": return canView ? yes : no("not shared with you");
    case "comment": return canView && (member || perms.has("team.member") || linkAllows("comment")) ? yes : no("only people in the group can comment");
    case "propose": return person && (member || perms.has("team.member") || linkAllows("propose")) ? yes : no("join the group or team to suggest work");
    case "claim": {
      const audience = record["audience"] as string | undefined;
      if (!person) return no("tell us your name first");
      if (audience === "open" && (record["sharing"] === "public" || canView || linkAllows("claim"))) return yes;
      if (audience === "organization" && member) return yes;
      if ((audience === "team" || audience === undefined) && perms.has("team.member")) return yes;
      return no("this work isn't open to you");
    }
    case "edit": return person && (involves(person, record) || perms.has("task.assign") || perms.has("org.manage")) ? yes : no("only the people on it, or its lead, can edit");
    case "assign": return perms.has("task.assign") ? yes : no("needs task.assign");
    case "confirm": return perms.has("task.confirm") || (person !== null && ref(record["reviewer"]) === person) ? yes : no("needs task.confirm or to be the reviewer");
    case "plan": return perms.has("initiative.plan") ? yes : no("needs initiative.plan");
    case "manage-members": return perms.has("member.manage") ? yes : no("needs member.manage");
    case "submit-report": return perms.has("report.submit") ? yes : no("needs report.submit");
    case "vote": {
      const eligible = ((record["eligible"] as Ref[] | undefined) ?? []).map((e) => e.reference);
      return person && eligible.includes(person) && record["status"] === "open" ? yes : no("not a voter, or voting is closed");
    }
  }
}
