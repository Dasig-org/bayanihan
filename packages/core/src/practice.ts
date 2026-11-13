import type { BixResource } from "./validate.js";
import type { Ref } from "./rules.js";

/**
 * Project memory (BIX spec "Project memory: Practices", 2026-11-13; rules 23–25).
 *
 * A Practice is one kind of step as a group does it, and how it has gone. Everything here is a deterministic rule:
 * the figures, what a project usually needs, what is usually done by now, and what usually comes first. The model's
 * part (is this step the same as a known Practice? does this one apply here? was this a one-off?) is not in Core; it
 * arrives as ChangeProposals in the `memory` assistance area and is checked like any other proposal.
 */

export type Observed = {
  included: number;
  ofProjects: number;
  addedLate: number;
  dayFromStart?: { median: number; earliest: number; latest: number };
  lastSeen?: string;
  basis: Ref[];
  calculated: string;
};

/** Days before the start inside which adding a step counts as "added late" (BIX: 7). */
export const LATE_WINDOW_DAYS = 7;
const DAY = 86_400_000;

const refOf = (r: BixResource) => `${r.resourceType}/${r.id}`;
const ref = (r: BixResource, k: string) => (r[k] as Ref | undefined)?.reference;
const codes = (cs: unknown) => ((cs as { system?: string; code?: string }[] | undefined) ?? []).map((c) => `${c.system ?? ""}|${c.code ?? ""}`);
const startOf = (i: BixResource) => (i["period"] as { start?: string } | undefined)?.start;
const doneDay = (t: BixResource) => {
  const p = t["executionPeriod"] as { start?: string; end?: string } | undefined;
  return p?.end ?? p?.start;
};
const days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / DAY);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Does this Practice apply to this Initiative? (Practice.appliesTo shares a code with Initiative.category.) */
export function appliesTo(practice: BixResource, initiative: BixResource): boolean {
  const want = new Set(codes(practice["appliesTo"]));
  return codes(initiative["category"]).some((c) => want.has(c));
}

/** The Tasks of an Initiative: steps whose partOf chain reaches it. `tasks` is every Task the caller holds. */
export function tasksOf(initiative: BixResource, tasks: BixResource[]): BixResource[] {
  const byRef = new Map(tasks.map((t) => [refOf(t), t]));
  const root = refOf(initiative);
  const reaches = (t: BixResource, seen = new Set<string>()): boolean => {
    const up = ref(t, "partOf");
    if (!up || seen.has(up)) return false;
    if (up === root) return true;
    seen.add(up);
    const parent = byRef.get(up);
    return parent ? reaches(parent, seen) : false;
  };
  return tasks.filter((t) => reaches(t));
}

/**
 * Calculate a Practice's `observed` figures (rule 23) from the organization's Initiatives and their Tasks.
 * `firstRecorded` gives a Task's earliest Provenance.occurredAt, for "added late".
 */
export function computeObserved(
  practice: BixResource,
  initiatives: BixResource[],
  tasks: BixResource[],
  firstRecorded: (taskRef: string) => string | undefined,
  now: string,
): Observed {
  const org = ref(practice, "organization");
  const me = refOf(practice);
  const projects = initiatives
    .filter((i) => i["status"] === "completed" && ref(i, "organization") === org && appliesTo(practice, i))
    .sort((a, b) => (startOf(a) ?? "").localeCompare(startOf(b) ?? ""));
  let included = 0, addedLate = 0, lastSeen: string | undefined;
  const offsets: number[] = [];
  for (const i of projects) {
    const steps = tasksOf(i, tasks).filter((t) => t["status"] !== "cancelled" && ref(t, "practice") === me);
    if (!steps.length) continue;
    included++;
    const start = startOf(i);
    if (start && (!lastSeen || start > lastSeen)) lastSeen = start;
    const first = steps.map((t) => firstRecorded(refOf(t))).filter((x): x is string => !!x).sort()[0];
    if (start && first && days(start, first) < LATE_WINDOW_DAYS) addedLate++;
    const done = steps.map(doneDay).filter((x): x is string => !!x).sort()[0];
    if (start && done) offsets.push(days(done, start));
  }
  const out: Observed = { included, ofProjects: projects.length, addedLate, basis: projects.map((i) => ({ reference: refOf(i) })), calculated: now };
  if (offsets.length) out.dayFromStart = { median: median(offsets), earliest: Math.min(...offsets), latest: Math.max(...offsets) };
  if (lastSeen) out.lastSeen = lastSeen;
  return out;
}

/** A Practice with freshly calculated figures, as the next version, ready for applyChange by a rule actor. */
export function withObserved(practice: BixResource, observed: Observed): BixResource {
  return { ...practice, observed, meta: { ...practice.meta, version: practice.meta.version + 1 } } as BixResource;
}

/** Evidence a coordinator sees beside a suggestion: "in 2 of your 3 projects like this". */
export function evidence(practice: BixResource): string {
  const o = practice["observed"] as Observed | undefined;
  if (!o || !o.ofProjects) return practice["source"] === "own" ? "new for your group" : "a common step for projects like this";
  const late = o.addedLate ? `; added late ${o.addedLate === 1 ? "once" : `${o.addedLate} times`}` : "";
  return `in ${o.included} of your ${o.ofProjects} projects like this${late}`;
}

export type Suggestion = { practice: BixResource; why: string };

/**
 * What does this project usually need that it doesn't have yet? (rule-side, before the model filters it)
 * Active Practices that apply, included in at least `minShare` of past projects (or starter/adopted ones with no
 * figures yet), with no Task in the project pointing to them.
 */
export function usuallyNeeded(initiative: BixResource, tasks: BixResource[], practices: BixResource[], minShare = 0.5): Suggestion[] {
  const have = new Set(tasksOf(initiative, tasks).filter((t) => t["status"] !== "cancelled").map((t) => ref(t, "practice")).filter(Boolean));
  return practices
    .filter((p) => p["status"] === "active" && ref(p, "organization") === ref(initiative, "organization") && appliesTo(p, initiative) && !have.has(refOf(p)))
    .filter((p) => {
      const o = p["observed"] as Observed | undefined;
      return o && o.ofProjects ? o.included / o.ofProjects >= minShare : p["source"] !== "own";
    })
    .map((p) => ({ practice: p, why: evidence(p) }));
}

/** Is anything usually done by now? Steps whose Practice's median day has passed and that aren't completed. */
export function usuallyDoneByNow(initiative: BixResource, tasks: BixResource[], practices: BixResource[], now: string): { task: BixResource; practice: BixResource; why: string }[] {
  const start = startOf(initiative);
  if (!start) return [];
  const today = days(now, start);
  const byRef = new Map(practices.map((p) => [refOf(p), p]));
  const out: { task: BixResource; practice: BixResource; why: string }[] = [];
  for (const t of tasksOf(initiative, tasks)) {
    if (["completed", "cancelled"].includes(String(t["status"]))) continue;
    const p = byRef.get(ref(t, "practice") ?? "");
    const m = (p?.["observed"] as Observed | undefined)?.dayFromStart?.median;
    if (p && m !== undefined && today > m) out.push({ task: t, practice: p, why: `usually done ${Math.abs(m)} days ${m < 0 ? "before" : "after"} the start` });
  }
  return out;
}

/** Is anything out of order? Pairs (later, earlier) where the earlier step's Practice is in the later one's `after[]`, but not in its dependsOn. */
export function outOfOrder(initiative: BixResource, tasks: BixResource[], practices: BixResource[]): { task: BixResource; shouldWaitOn: BixResource }[] {
  const mine = tasksOf(initiative, tasks).filter((t) => t["status"] !== "cancelled");
  const byPractice = new Map<string, BixResource>();
  for (const t of mine) { const p = ref(t, "practice"); if (p && !byPractice.has(p)) byPractice.set(p, t); }
  const byRef = new Map(practices.map((p) => [refOf(p), p]));
  const out: { task: BixResource; shouldWaitOn: BixResource }[] = [];
  for (const t of mine) {
    const p = byRef.get(ref(t, "practice") ?? "");
    const deps = new Set(((t["dependsOn"] as Ref[] | undefined) ?? []).map((d) => d.reference));
    for (const a of (p?.["after"] as Ref[] | undefined) ?? []) {
      const earlier = byPractice.get(a.reference);
      if (earlier && earlier !== t && !deps.has(refOf(earlier))) out.push({ task: t, shouldWaitOn: earlier });
    }
  }
  return out;
}

/** Closing a project: which Practices to recalculate, and which steps have no Practice yet (to match, keep, or leave). */
export function closeOut(initiative: BixResource, tasks: BixResource[], practices: BixResource[]): { recalculate: BixResource[]; unmatched: BixResource[] } {
  return {
    recalculate: practices.filter((p) => ref(p, "organization") === ref(initiative, "organization") && appliesTo(p, initiative)),
    unmatched: tasksOf(initiative, tasks).filter((t) => t["status"] !== "cancelled" && !ref(t, "practice")),
  };
}

/** A Practice as shared outside its organization (rule 25): no projects counted, no lesson authors. */
export function shareable(practice: BixResource): BixResource {
  const o = practice["observed"] as Observed | undefined;
  const { basis: _basis, ...rest } = o ?? ({} as Observed);
  const lessons = ((practice["lesson"] as { text: string; time: string }[] | undefined) ?? []).map(({ text, time }) => ({ text, time }));
  // The rest of observed (counts and days) stays: it says how a step goes without saying who or which project.
  const out: BixResource = { ...practice };
  if (o) out["observed"] = rest;
  if (lessons.length) out["lesson"] = lessons; else delete out["lesson"];
  return out;
}

/** Adopting a shared or starter Practice: a copy that belongs to the group, with no figures and anonymous lessons (rule 25). */
export function adopt(practice: BixResource, organization: Ref, id: string): BixResource {
  const { observed: _o, ...rest } = shareable(practice) as BixResource & { observed?: unknown };
  return { ...rest, id, meta: { version: 1 }, organization, source: "adopted", adoptedFrom: { reference: refOf(practice) }, status: "draft" } as BixResource;
}
