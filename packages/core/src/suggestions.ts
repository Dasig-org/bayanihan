import type { BixResource } from "./validate.js";
import type { AssistedBy } from "./rules.js";

/*
 * BIX "Suggestions and their answers" (2026-11-14). A suggestion is a record only once a person answers it: accepting
 * commits the change with `Context.assistedBy`; "Not this time" commits a declined ChangeProposal (below), so it isn't
 * suggested again; the measure reads both.
 */
type Ref = { reference: string };
const ref = (x: unknown) => (x as { reference?: string } | undefined)?.reference;

const AREA = { system: "bayanihan:assist-area", code: "memory" };
const ext = (p: BixResource, url: string) => ((p["extension"] as { url: string; value?: unknown }[] | undefined) ?? []).find((e) => e.url === url)?.value;
const isMemory = (p: BixResource) => (p["area"] as { code?: string } | undefined)?.code === "memory";

/**
 * The declined ChangeProposal for "Not this time". `change` says what it would have done; with none given, an "add"
 * of the suggested step (its title and Practice) under the target. Never applied: it records the answer.
 */
export function declineSuggestion(o: { id: string; target: Ref; basedOn: number; organization: Ref; practice?: Ref; question?: string; title?: string; change?: { op: "add" | "remove" | "replace"; path: string; value?: unknown }[]; reason?: string }): BixResource {
  return { resourceType: "ChangeProposal", id: o.id, meta: { version: 1 }, target: o.target, basedOn: o.basedOn, organization: o.organization, area: AREA, status: "declined",
    change: o.change ?? [{ op: "add", path: "/suggestedStep", value: { ...(o.title ? { title: o.title } : {}), ...(o.practice ? { practice: o.practice } : {}) } }],
    extension: [...(o.practice ? [{ url: "bayanihan:practice", value: o.practice.reference }] : []), ...(o.question ? [{ url: "bayanihan:question", value: o.question }] : [])],
    ...(o.reason ? { reason: o.reason } : {}) } as BixResource;
}

/** Was this suggestion already declined for this target (same area and Practice)? Then don't show it again. */
export function wasDeclined(proposals: BixResource[], target: string, practice?: string): boolean {
  return proposals.some((p) => p["status"] === "declined" && isMemory(p) && ref(p["target"]) === target && (!practice || ext(p, "bayanihan:practice") === practice));
}

export type SuggestionStats = Record<string, { used: number; edited: number; declined: number }>;
/** The measure (sketch 23): per question, accepted unchanged, edited first, declined, from Provenance and declined proposals. */
export function suggestionStats(provenances: BixResource[], proposals: BixResource[], since?: string, ignoreVersions: string[] = []): SuggestionStats {
  const out: SuggestionStats = {};
  const bump = (q: string, k: "used" | "edited" | "declined") => { (out[q] ??= { used: 0, edited: 0, declined: 0 })[k]++; };
  const keep = (when: unknown) => !since || String(when ?? "") >= since;
  for (const p of provenances) {
    if (!keep(p["occurredAt"])) continue;
    const agents = (p["agent"] as { type: string; model?: { version?: string; question?: string; edited?: boolean }; rule?: string }[] | undefined) ?? [];
    if (!agents.some((a) => a.type === "author")) continue;
    for (const a of agents) {
      if (a.type === "model" && a.model && !ignoreVersions.includes(a.model.version ?? "")) bump(a.model.question ?? "other", a.model.edited ? "edited" : "used");
      if (a.type === "rule" && a.rule?.startsWith("memory:")) bump(a.rule.slice(7), "used");
    }
  }
  for (const c of proposals) if (c["status"] === "declined" && isMemory(c) && keep((c["meta"] as { lastUpdated?: string } | undefined)?.lastUpdated)) bump(String(ext(c, "bayanihan:question") ?? "other"), "declined");
  return out;
}
export type { AssistedBy };
