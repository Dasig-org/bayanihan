import { validate, type BixResource } from "./validate.js";
import { canTransition, lifecycles } from "./lifecycle.js";

export type Ref = { reference: string };
export type Actor =
  | { type: "person"; person: Ref }
  | { type: "model"; model: { name: string; version: string }; onBehalfOf: Ref }
  | { type: "rule"; rule: string };

export type Context = {
  actor: Actor;
  /** BIX permission codes the actor holds for this record, from Roles, Positions and Team leadership. Resolved by the caller. */
  permissions: string[];
  now: string;
  offline?: boolean;
  /** For Tasks: does this step involve money or beneficiaries? (from its TaskDefinition) */
  involvesMoneyOrBeneficiaries?: boolean;
  /** For Tasks: does this kind of work need review? (TaskDefinition.review or Task.reviewer) */
  reviewRequired?: boolean;
  /** The actor made this draft (from its Provenance), so they may withdraw it, and cancel its drafts, without a lead's permission. */
  closesOwnDraft?: boolean;
  /** The id generator for new Provenance records. */
  newId: () => string;
};

export type ChangeResult =
  | { ok: true; record: BixResource; provenance: BixResource }
  | { ok: false; reasons: string[] };

const state = (r: BixResource | null) => {
  if (!r) return undefined;
  const lc = lifecycles[r.resourceType];
  return lc ? (r[lc.field] as string | undefined) : undefined;
};
const isDraft = (r: BixResource) => r["status"] === "draft" || r["intent"] === "proposal";
const same = (a?: Ref, b?: Ref) => !!a && !!b && a.reference === b.reference;
const performers = (t: BixResource): string[] =>
  ((t["participant"] as { person: Ref; status: string }[] | undefined) ?? [])
    .filter((p) => p.status === "active")
    .map((p) => p.person.reference);

function activity(prev: BixResource | null, next: BixResource): string {
  if (!prev) return isDraft(next) ? "propose" : "create";
  const a = state(prev), b = state(next);
  if (next.resourceType === "Task") {
    if (a === "ready" && b === "accepted") return "claim";
    if (a === "ready" && b === "requested") return "assign";
    if (a === "requested" && b === "accepted") return "accept";
    if (a === "requested" && b === "ready") return "decline";
    if (a !== "ready" && b === "ready" && a !== "draft") return "release";
    if (b === "completed") return "complete";
    if (prev["verification"] !== "confirmed" && next["verification"] === "confirmed") return "confirm";
  }
  if (b === "cancelled") return "cancel";
  if (b === "submitted") return "submit";
  if (b === "revoked") return "revoke";
  return "update";
}

/**
 * The one place a change to a BIX record is allowed or refused.
 * Enforces: schema validity, version checks (rule 16), lifecycles, propose-then-commit (rules 3–4),
 * owner-only acceptance (rule 17), and a second person for money and beneficiaries (rule 5).
 * Returns the committed record with its Provenance, or the reasons it was refused.
 */
export function applyChange(prev: BixResource | null, next: BixResource, ctx: Context): ChangeResult {
  const reasons: string[] = [];
  const v = validate(next);
  if (!v.valid) reasons.push(...v.errors.map((e) => `invalid ${e.path}: ${e.message}`));

  if (prev) {
    if (prev.resourceType !== next.resourceType || prev.id !== next.id) reasons.push("a change must keep the same type and id");
    if (next.meta.version !== prev.meta.version + 1) reasons.push(`stale change: based on version ${next.meta.version - 1}, current is ${prev.meta.version}`);
    const a = state(prev), b = state(next);
    if (a && b && !canTransition(next.resourceType, a, b)) reasons.push(`${next.resourceType} cannot go from ${a} to ${b}`);
  } else if (next.meta.version !== 1) reasons.push("a new record starts at version 1");

  // Nothing is orphaned: every record says who it belongs to, and that can't be changed later.
  // (A group's ownership moves by recorded hand-over of its officers, never by re-pointing its records.)
  const ref = (r: BixResource | null, k: string) => (r?.[k] as Ref | undefined)?.reference;
  const OWNERS: Record<string, string[][]> = {
    Initiative: [["organization"], ["person"]],
    Team: [["organization"]],
    Task: [["partOf"], ["team"], ["owner"]],
    Need: [["initiative"]],
    Role: [["person", "organization"]],
    Position: [["organization"]],
  };
  const needs = OWNERS[next.resourceType];
  if (needs && !needs.some((ks) => ks.every((k) => ref(next, k)))) reasons.push(`a ${next.resourceType} must belong to ${needs.map((ks) => ks.join(" and ")).join(" or ")}`);
  if (prev) for (const k of ["organization", "person", "partOf", "initiative", "team"]) {
    if (next.resourceType === "Task" && k === "team") continue; // work can move between a project's teams
    if (next.resourceType === "Person") continue;
    if (ref(prev, k) && ref(prev, k) !== ref(next, k)) reasons.push(`a ${next.resourceType}'s ${k} can't be changed`);
  }

  // A model only ever proposes (rules 3–4).
  if (ctx.actor.type === "model") {
    if (!isDraft(next)) reasons.push("a model may only create or edit drafts");
    if (prev && !isDraft(prev)) reasons.push("a model may not change a committed record");
  }

  // Leaving draft needs a person with permission, or a declared rule (rule 4).
  const closingOwn = !!ctx.closesOwnDraft && ["cancelled", "withdrawn"].includes(String(state(next)));
  if (prev && isDraft(prev) && !isDraft(next) && !closingOwn && ctx.actor.type === "person" && !ctx.permissions.some((p) => ["task.assign", "initiative.plan", "member.manage", "org.manage"].includes(p))) {
    reasons.push("accepting a proposal needs a lead's permission");
  }

  // A group's assistance areas are its own choice: only a person with org.manage changes them (BIX rule 22).
  if (next.resourceType === "Organization" && JSON.stringify(prev?.["assist"] ?? []) !== JSON.stringify(next["assist"] ?? [])) {
    if (ctx.actor.type !== "person" || !ctx.permissions.includes("org.manage")) reasons.push("turning assistance on or off needs org.manage");
  }

  if (next.resourceType === "Task" && prev && ctx.actor.type === "person") {
    const a = state(prev), b = state(next), me = ctx.actor.person;
    const owner = next["owner"] as Ref | undefined;
    // Claiming: you may only make yourself the owner.
    // (A shift with several places fills up instead: it stays owned by its team; BIX 2026-11-09.)
    const shiftFull = ((next["slots"] as number | undefined) ?? 1) > 1 && same(owner, prev["owner"] as Ref);
    if (a === "ready" && b === "accepted" && !same(owner, me) && !shiftFull) reasons.push("you can claim a task only for yourself");
    // Asking someone needs task.assign.
    if (a === "ready" && b === "requested" && !ctx.permissions.includes("task.assign")) reasons.push("asking someone needs task.assign");
    // Only the person asked can accept (rule 17).
    if (a === "requested" && b === "accepted" && !same(prev["owner"] as Ref, me)) reasons.push("only the person asked can accept");
    // Confirming: never your own work when money or beneficiaries are involved (rule 5).
    if (prev["verification"] !== "confirmed" && next["verification"] === "confirmed") {
      if (ctx.involvesMoneyOrBeneficiaries && performers(next).includes(me.reference)) reasons.push("someone other than the performer must confirm this");
      if (!ctx.permissions.includes("task.confirm") && !ctx.permissions.includes("reviewer")) reasons.push("confirming needs task.confirm or being the reviewer");
    }
  }

  // Shifts, showing up and time (BIX "Shifts, showing up and time", 2026-11-09).
  if (next.resourceType === "Task") {
    type P = { person: Ref; role: string; status: string; attended?: { at: string; by: Ref }; replaces?: Ref };
    const parts = (r: BixResource | null) => ((r?.["participant"] as P[] | undefined) ?? []);
    const key = (x: P) => x.person.reference;
    const slots = (next["slots"] as number | undefined) ?? 1;
    const activeN = parts(next).filter((x) => x.status === "active").length;
    if (slots > 1 && activeN > slots) reasons.push(`this work has ${slots} places and they're all taken`);
    const actor = ctx.actor.type === "person" ? ctx.actor.person.reference : null;
    const lead = ctx.permissions.includes("task.assign");
    for (const x of parts(next)) {
      const was = parts(prev).find((y) => key(y) === key(x) && !!y.replaces === !!x.replaces);
      // Check-in: by the person themselves or a lead; never by a model.
      if (x.attended && JSON.stringify(x.attended) !== JSON.stringify(was?.attended)) {
        if (ctx.actor.type === "model") reasons.push("a model can't check anyone in");
        else if (x.attended.by?.reference !== actor) reasons.push("a check-in is recorded by whoever makes it");
        else if (actor !== key(x) && !lead) reasons.push("only the person or a lead can check someone in");
      }
      // Hours given: by the person or a lead; never by a model (BIX "Planned and given time").
      if (JSON.stringify((x as any).hours) !== JSON.stringify((was as any)?.hours) && (x as any).hours) {
        if (ctx.actor.type === "model") reasons.push("a model can't record anyone's hours");
        else if (actor !== key(x) && !lead) reasons.push("only the person or a lead can record their hours");
      }
      // Swap: proposed by the replaced person or a lead; made active only by the named person.
      if (x.replaces) {
        if (!was && !(actor === x.replaces.reference || lead)) reasons.push("only the person on it, or a lead, can propose a swap");
        if (was && was.status !== "active" && x.status === "active" && actor !== key(x)) reasons.push("only the person asked can accept the swap");
        if (x.status === "active" && parts(next).some((y) => key(y) === x.replaces!.reference && y.status === "active")) reasons.push("a swap ends the place of the person it replaces");
      }
    }
  }

  // Recorded when done: completed work needs review only when it matters.
  let record = next;
  if (next.resourceType === "Task" && state(prev) !== "completed" && state(next) === "completed" && next["verification"] === undefined) {
    record = { ...next, verification: ctx.involvesMoneyOrBeneficiaries || ctx.reviewRequired ? "pending" : "not-required" };
  }

  if (reasons.length) return { ok: false, reasons };
  // When this version was made (FHIR meta.lastUpdated), so apps can say "2 hours ago" without reading history.
  record = { ...record, meta: { ...record.meta, lastUpdated: ctx.now } } as BixResource;

  const agent =
    ctx.actor.type === "person" ? [{ type: "author", who: ctx.actor.person }]
    : ctx.actor.type === "model" ? [{ type: "model", model: ctx.actor.model }, { type: "author", who: ctx.actor.onBehalfOf }]
    : [{ type: "rule" }];
  const provenance: BixResource = {
    resourceType: "Provenance",
    id: ctx.newId(),
    meta: { version: 1 },
    target: [{ reference: `${record.resourceType}/${record.id}` }],
    activity: activity(prev, record),
    agent,
    occurredAt: ctx.now,
    offline: !!ctx.offline,
  };
  return { ok: true, record, provenance };
}
