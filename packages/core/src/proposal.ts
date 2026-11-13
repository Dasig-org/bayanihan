import type { BixResource } from "./validate.js";
import { validate } from "./validate.js";
import { applyChange, type Context, type Ref } from "./rules.js";

/**
 * Proposed edits and assistance (BIX spec "Proposed edits and assistance", 2026-11-11; rules 20–22).
 *
 * A ChangeProposal is a suggested edit to a record that already exists: JSON Patch operations (`change[]`) made against
 * a known version (`basedOn`), plus new draft records accepted with it (`includes[]`). This module checks a proposal
 * when it is made, applies it when someone accepts it (through `applyChange`, so every rule for a direct change still
 * holds), declines or withdraws it, and marks it outdated when its target moved on.
 */

export type PatchOp = { op: "add" | "remove" | "replace"; path: string; value?: unknown };
export type ProposalResult =
  | { ok: true; records: BixResource[]; provenance: BixResource[] }
  | { ok: false; reasons: string[]; outdated?: boolean };

const AREA_SYSTEM = "bayanihan:assist-area";
const ref = (r: BixResource) => `${r.resourceType}/${r.id}`;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const bump = (r: BixResource, over: Record<string, unknown>): BixResource =>
  ({ ...r, ...over, meta: { ...r.meta, version: r.meta.version + 1 } }) as BixResource;

/** The assistance areas a group turned on (Organization.assist[]). Absent or empty means none (rule 22). */
export function assistAreas(org: BixResource | null | undefined): string[] {
  return ((org?.["assist"] as { system?: string; code?: string }[] | undefined) ?? [])
    .filter((c) => !c.system || c.system === AREA_SYSTEM)
    .map((c) => c.code ?? "")
    .filter(Boolean);
}
export const assistOn = (org: BixResource | null | undefined, area: string) => assistAreas(org).includes(area);

/** Apply a JSON Patch subset (RFC 6902 add, remove, replace) to a copy. Throws on a path that doesn't resolve. */
export function applyPatch<T extends object>(doc: T, ops: PatchOp[]): T {
  const out = clone(doc) as Record<string, unknown>;
  for (const o of ops) {
    const keys = o.path.split("/").slice(1).map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (!keys.length || keys[0] === "") throw new Error(`invalid path ${o.path}`);
    let parent: unknown = out;
    for (const k of keys.slice(0, -1)) {
      const next = Array.isArray(parent) ? parent[Number(k)] : (parent as Record<string, unknown>)[k];
      if (next === undefined || next === null || typeof next !== "object") throw new Error(`path ${o.path} doesn't exist`);
      parent = next;
    }
    const last = keys[keys.length - 1]!;
    if (Array.isArray(parent)) {
      const i = last === "-" ? parent.length : Number(last);
      if (!Number.isInteger(i) || i < 0 || i > parent.length || (o.op !== "add" && i >= parent.length)) throw new Error(`index ${last} out of range in ${o.path}`);
      if (o.op === "add") parent.splice(i, 0, clone(o.value));
      else if (o.op === "remove") parent.splice(i, 1);
      else parent[i] = clone(o.value);
    } else {
      const p = parent as Record<string, unknown>;
      // A missing array is created by appending to it, e.g. "/dependsOn/-" on a Task with no dependsOn yet.
      if (o.op === "remove" || o.op === "replace") { if (!(last in p)) throw new Error(`path ${o.path} doesn't exist`); }
      if (o.op === "remove") delete p[last];
      else p[last] = clone(o.value);
    }
  }
  return out as T;
}

/** Normalise "/dependsOn/-" on a record without that array into an add of a one-item array. */
function prepare(target: BixResource, ops: PatchOp[]): PatchOp[] {
  return ops.map((o) => {
    const m = /^\/([A-Za-z]+)\/-$/.exec(o.path);
    const k = m?.[1];
    if (o.op === "add" && k && target[k] === undefined) return { op: "add", path: `/${k}`, value: [o.value] };
    return o;
  });
}

/** Resource types no proposal may target, and elements no proposal may change (rule 21). */
const NEVER_TARGET = new Set(["Vote", "Role", "Consent", "SharingPolicy", "Provenance", "ChangeProposal"]);
const NEVER_CHANGE: Record<string, string[]> = {
  Report: ["figures"],
  Decision: ["outcome"],
  Organization: ["assist"],
  Task: ["verification"],
  Practice: ["observed"],
};

/** Reasons a proposed change touches something off limits, comparing the target before and after the patch. */
function forbidden(before: BixResource, after: BixResource, onBehalfOf: string | null): string[] {
  const reasons: string[] = [];
  if (NEVER_TARGET.has(before.resourceType)) reasons.push(`a proposal can't change a ${before.resourceType}`);
  if (before.resourceType === "Person" && onBehalfOf !== ref(before)) reasons.push("a proposal can't change another person's record");
  for (const k of NEVER_CHANGE[before.resourceType] ?? []) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) reasons.push(`a proposal can't change ${before.resourceType}.${k}`);
  }
  if (before.resourceType === "Task") {
    type P = { person: Ref; attended?: unknown };
    const att = (r: BixResource) => JSON.stringify(((r["participant"] as P[] | undefined) ?? []).map((p) => [p.person?.reference, p.attended ?? null]));
    if (att(before) !== att(after)) reasons.push("a proposal can't record attendance");
    const owner = (after["owner"] as Ref | undefined)?.reference;
    if (owner !== (before["owner"] as Ref | undefined)?.reference && owner?.startsWith("Person/")) {
      reasons.push("a proposal can't make a person a task's owner; suggest them with /suggestedFor instead");
    }
  }
  return reasons;
}

export type ProposalContext = Context & {
  /** The organization the proposal belongs to, with its `assist[]` (rule 22). */
  organization: BixResource;
};

/**
 * Check a new ChangeProposal before it is saved (rules 3, 20–22), then commit it as a draft with its Provenance.
 * Anyone with an active Role may propose; a model only on behalf of a person, and a model or rule only in an area that is on.
 */
export function proposeChange(proposal: BixResource, target: BixResource, includes: BixResource[], ctx: ProposalContext): ProposalResult {
  const reasons: string[] = [];
  if (proposal.resourceType !== "ChangeProposal") return { ok: false, reasons: ["not a ChangeProposal"] };
  if (proposal["status"] !== "draft") reasons.push("a new proposal starts as a draft");
  if ((proposal["target"] as Ref | undefined)?.reference !== ref(target)) reasons.push("the target given isn't the proposal's target");
  if ((proposal["organization"] as Ref | undefined)?.reference !== ref(ctx.organization)) reasons.push("the organization given isn't the proposal's organization");
  if (proposal["basedOn"] !== target.meta.version) reasons.push(`based on version ${String(proposal["basedOn"])}, current is ${target.meta.version}`);

  const assisted = ctx.actor.type === "model" || ctx.actor.type === "rule";
  const area = (proposal["area"] as { code?: string } | undefined)?.code;
  if (assisted) {
    if (!area) reasons.push("a proposal from a model or rule must name its area");
    else if (!assistOn(ctx.organization, area)) reasons.push(`the group hasn't turned on ${area}`);
    if (!String(proposal["reason"] ?? "").trim()) reasons.push("a proposal from a model or rule must give a reason");
  }

  const listed = ((proposal["includes"] as Ref[] | undefined) ?? []).map((r) => r.reference).sort();
  const given = includes.map(ref).sort();
  if (JSON.stringify(listed) !== JSON.stringify(given)) reasons.push("the drafts given don't match the proposal's includes");
  for (const d of includes) if (d["status"] !== "draft" && d["intent"] !== "proposal") reasons.push(`${ref(d)} must be a draft`);

  const onBehalf = ctx.actor.type === "person" ? ctx.actor.person.reference : ctx.actor.type === "model" ? ctx.actor.onBehalfOf.reference : null;
  try {
    const after = applyPatch(target, prepare(target, (proposal["change"] as PatchOp[] | undefined) ?? []));
    reasons.push(...forbidden(target, after, onBehalf));
    const v = validate(after);
    if (!v.valid) reasons.push(...v.errors.map((e) => `the change would make the record invalid at ${e.path}: ${e.message}`));
  } catch (e) {
    reasons.push((e as Error).message);
  }
  if (reasons.length) return { ok: false, reasons };

  const records: BixResource[] = [], provenance: BixResource[] = [];
  for (const r of [proposal, ...includes]) {
    const c = applyChange(null, r, ctx);
    if (!c.ok) return { ok: false, reasons: c.reasons };
    records.push(c.record); provenance.push(c.provenance);
  }
  return { ok: true, records, provenance };
}

/** The state a draft moves to when its proposal is accepted. */
function committed(d: BixResource): Record<string, unknown> {
  switch (d.resourceType) {
    case "Task": return { intent: "plan", status: "ready" };
    case "Need": return { status: "open" };
    case "Offer": return { status: "available" };
    case "Initiative": return { status: "planned" };
    default: return { status: "active" };
  }
}

/**
 * Accept a proposal (rule 20): apply its change to the target, move its drafts out of draft, and mark it accepted,
 * all or nothing. Every step goes through `applyChange` with the accepting person's permissions, so it needs exactly
 * what making the change directly would need. If the target moved on, nothing is applied and `outdated` is true.
 */
export function acceptProposal(proposal: BixResource, target: BixResource, includes: BixResource[], ctx: Context): ProposalResult {
  if (ctx.actor.type !== "person") return { ok: false, reasons: ["only a person can accept a proposal"] };
  if (proposal["status"] !== "draft") return { ok: false, reasons: [`this proposal is already ${String(proposal["status"])}`] };
  if (proposal["basedOn"] !== target.meta.version) return { ok: false, outdated: true, reasons: ["the record changed after this was suggested"] };

  const records: BixResource[] = [], provenance: BixResource[] = [];
  const step = (prev: BixResource, next: BixResource) => {
    const c = applyChange(prev, next, { ...ctx, viaProposal: true });
    if (!c.ok) return c.reasons;
    records.push(c.record); provenance.push(c.provenance);
    return null;
  };
  const ops = (proposal["change"] as PatchOp[] | undefined) ?? [];
  if (ops.length) {
    let patched: BixResource;
    try { patched = applyPatch(target, prepare(target, ops)); } catch (e) { return { ok: false, reasons: [(e as Error).message] }; }
    const r = step(target, bump(patched, {}));
    if (r) return { ok: false, reasons: r };
  }
  for (const d of includes) {
    const r = step(d, bump(d, committed(d)));
    if (r) return { ok: false, reasons: r };
  }
  const r = step(proposal, bump(proposal, { status: "accepted" }));
  if (r) return { ok: false, reasons: r };
  return { ok: true, records, provenance };
}

/** Decline (a lead) or withdraw (its author, or by rule): the proposal closes and its drafts are cancelled. */
export function closeProposal(proposal: BixResource, includes: BixResource[], how: "declined" | "withdrawn" | "outdated", ctx: Context): ProposalResult {
  if (proposal["status"] !== "draft") return { ok: false, reasons: [`this proposal is already ${String(proposal["status"])}`] };
  if (how === "outdated" && ctx.actor.type !== "rule") return { ok: false, reasons: ["a proposal is marked outdated only by rule"] };
  const records: BixResource[] = [], provenance: BixResource[] = [];
  const cancel = (d: BixResource) => bump(d, d.resourceType === "Offer" ? { status: "withdrawn" } : { status: "cancelled" });
  for (const [prev, next] of [...includes.map((d) => [d, cancel(d)] as const), [proposal, bump(proposal, { status: how })] as const]) {
    const c = applyChange(prev, next, ctx);
    if (!c.ok) return { ok: false, reasons: c.reasons };
    records.push(c.record);
    provenance.push({ ...c.provenance, activity: how === "declined" ? "decline" : "cancel" });
  }
  return { ok: true, records, provenance };
}

/** Is this open proposal outdated, because its target moved past the version it was made against? */
export const isOutdated = (proposal: BixResource, target: BixResource) =>
  proposal["status"] === "draft" && typeof proposal["basedOn"] === "number" && target.meta.version > (proposal["basedOn"] as number);

/** Open proposals in areas the group has turned off, to be withdrawn by rule (rule 22). */
export function proposalsToWithdraw(proposals: BixResource[], org: BixResource): BixResource[] {
  const on = new Set(assistAreas(org));
  return proposals.filter((p) => {
    const area = (p["area"] as { code?: string } | undefined)?.code;
    return p["status"] === "draft" && !!area && !on.has(area);
  });
}
