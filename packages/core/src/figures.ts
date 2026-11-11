import type { BixResource } from "./validate.js";

type Period = { start?: string; end?: string };
const inside = (p: Period | undefined, range: Period) =>
  !!p?.start && (!range.start || p.start >= range.start) && (!range.end || (p.end ?? p.start) <= range.end);
const code = (c: unknown) => (c as { code?: string } | undefined)?.code;
const done = (t: BixResource) => t["status"] === "completed" && t["verification"] !== "pending" && t["verification"] !== "disputed" && t["verification"] !== "changes-requested";

export type Figure = { value: number; derivedFrom: string[] };

/**
 * Report figures are calculated, never typed (rule 12). Each figure rule from the
 * bayanihan:figure-rule value set is implemented here, so every BIX app gets the same number.
 */
export function computeFigure(rule: { code: string; params?: Record<string, string> }, records: BixResource[], period: Period): Figure {
  const p = rule.params ?? {};
  const tasks = records.filter((r) => r.resourceType === "Task" && done(r) && inside(r["executionPeriod"] as Period, period));
  const refs = (rs: BixResource[]) => rs.map((r) => `${r.resourceType}/${r.id}`);
  switch (rule.code) {
    case "count-participants": {
      const m = tasks.filter((t) => !p.taskCode || code(t["code"]) === p.taskCode);
      const people = new Set(m.flatMap((t) => ((t["participant"] as { person: { reference: string }; status: string; attended?: unknown }[] | undefined) ?? [])
        .filter((x) => x.status === "active" && (!p.attended || x.attended)).map((x) => x.person.reference)));
      return { value: people.size, derivedFrom: refs(m) };
    }
    case "count-tasks": {
      const m = tasks.filter((t) => !p.taskCode || code(t["code"]) === p.taskCode);
      return { value: m.length, derivedFrom: refs(m) };
    }
    case "sum-task-hours": {
      const m = tasks.filter((t) => !p.taskCode || code(t["code"]) === p.taskCode);
      // Per person, first match wins (BIX "Planned and given time", 2026-11-11): own period, own hours, the shift's
      // window, the estimate. Never executionPeriod (taken → marked done), which isn't time given.
      const hours = m.reduce((sum, t) => sum + taskHours(t), 0);
      return { value: Math.round(hours * 100) / 100, derivedFrom: refs(m) };
    }
    case "sum-task-output": {
      let v = 0; const m: BixResource[] = [];
      for (const t of tasks) for (const o of (t["output"] as { code?: unknown; value?: unknown }[] | undefined) ?? [])
        if (code(o.code) === p.outputCode && typeof o.value === "number") { v += o.value; m.push(t); }
      return { value: v, derivedFrom: refs([...new Set(m)]) };
    }
    case "sum-received": {
      const m = records.filter((r) => r.resourceType === "Need" && code(r["category"]) === p.needCategory);
      return { value: m.reduce((s, r) => s + ((r["received"] as { value?: number } | undefined)?.value ?? 0), 0), derivedFrom: refs(m) };
    }
    case "sum-part-reports": {
      const m = records.filter((r) => r.resourceType === "Report" && ["submitted", "acknowledged"].includes(r["status"] as string) && inside(r["period"] as Period, period));
      let v = 0;
      for (const r of m) for (const f of (r["figures"] as { code?: unknown; value?: number }[] | undefined) ?? []) if (code(f.code) === p.figureCode) v += f.value ?? 0;
      return { value: v, derivedFrom: refs(m) };
    }
    default:
      throw new Error(`unknown figure rule: ${rule.code}`);
  }
}

/** Public views never show small numbers for one place and group. */
export const publicFigure = (value: number): string => (value > 0 && value < 5 ? "fewer than 5" : String(value));

type P = { status: string; period?: Period; hours?: { value: number } };
const span = (e?: Period) => (e?.start && e?.end ? Math.max(0, (Date.parse(e.end) - Date.parse(e.start)) / 3_600_000) : 0);
/** Hours one person gave to one piece of work, by the BIX counting order. */
export function personHours(t: BixResource, x: P): number {
  if (x.period?.start && x.period?.end) return span(x.period);
  if (x.hours) return x.hours.value;
  const shift = (t["restriction"] as { period?: Period } | undefined)?.period;
  if (shift?.start && shift?.end) return span(shift);
  const est = t["estimate"] as { value: number; unit: "min" | "h"; per?: "person" | "task" } | undefined;
  if (!est) return 0;
  const h = est.unit === "min" ? est.value / 60 : est.value;
  const n = ((t["participant"] as P[] | undefined) ?? []).filter((y) => y.status === "active").length || 1;
  return est.per === "task" ? h / n : h;
}
/** Hours everyone gave to one piece of work. */
export function taskHours(t: BixResource): number {
  return ((t["participant"] as P[] | undefined) ?? []).filter((x) => x.status === "active").reduce((h, x) => h + personHours(t, x), 0);
}
