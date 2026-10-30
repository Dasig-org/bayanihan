import type { BixResource } from "./validate.js";

export type Outcome = { status: "decided" | "no-quorum"; option: string[]; tally: Record<string, number> };

/** The outcome of a Decision is counted here, never set (spec: "Decisions and voting"). */
export function countVotes(decision: BixResource, votes: BixResource[]): Outcome {
  const eligible = new Set(((decision["eligible"] as { reference: string }[] | undefined) ?? []).map((e) => e.reference));
  const closes = decision["closes"] as string | undefined;
  // Last vote per eligible voter, cast before closing.
  const last = new Map<string, BixResource>();
  for (const v of [...votes].sort((a, b) => String(a["cast"]).localeCompare(String(b["cast"])))) {
    const who = (v["voter"] as { reference: string }).reference;
    if (eligible.size && !eligible.has(who)) continue;
    if (closes && String(v["cast"]) > closes) continue;
    last.set(who, v);
  }
  const quorum = (decision["quorum"] as number | undefined) ?? 0;
  const tally: Record<string, number> = {};
  for (const v of last.values()) for (const c of (v["choice"] as string[] | undefined) ?? []) tally[c] = (tally[c] ?? 0) + 1;
  if (last.size < quorum) return { status: "no-quorum", option: [], tally };
  const method = decision["method"] as string;
  const threshold = decision["threshold"] as string | undefined;
  const n = last.size;
  if (method === "consent") {
    const objections = [...last.values()].filter((v) => v["objection"] === true).length;
    return { status: "decided", option: objections === 0 ? ["consent"] : [], tally: { objections } };
  }
  const best = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const top = best[0];
  if (!top) return { status: "decided", option: [], tally };
  const need = threshold === "unanimous" ? n : threshold === "two-thirds" ? Math.ceil((2 * n) / 3) : Math.floor(n / 2) + 1;
  const passes = method === "choose-one" && threshold !== "unanimous" && threshold !== "two-thirds" ? top[1] > (best[1]?.[1] ?? 0) : top[1] >= need;
  return { status: "decided", option: passes ? [top[0]] : [], tally };
}
