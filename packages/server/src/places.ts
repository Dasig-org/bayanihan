import { readFileSync } from "node:fs";

/**
 * Philippine places by PSGC code, for picking where a group or event is (data/psgc.json; credits in data/PSGC_NOTICE.md).
 * Loaded on first use. Search matches every word as a prefix of the place's name or its parents' ("lahug cebu").
 */
export type Place = { code: string; name: string; kind: "region" | "province" | "city" | "municipality" | "submunicipality" | "barangay" | "other"; label: string };
const KIND: Record<string, Place["kind"]> = { r: "region", p: "province", c: "city", m: "municipality", s: "submunicipality", b: "barangay" };
const FILLER = new Set(["brgy", "bgy", "barangay", "city", "of", "the", "municipality", "province", "poblacion"]);
const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9ñ ]+/g, " ").split(/\s+/).filter((w) => w && !FILLER.has(w));

let index: { place: Place; tokens: string[]; rank: number }[] | null = null;
export let psgcVersion = "";
function load() {
  if (index) return index;
  const d = JSON.parse(readFileSync(new URL("../data/psgc.json", import.meta.url), "utf8")) as { version: string; places: [string, string, string, string][] };
  psgcVersion = d.version;
  const by = new Map(d.places.map((p) => [p[0], p]));
  index = d.places.filter((p) => p[2] !== "r").map(([code, name, t, parent]) => {
    const chain: string[] = []; let up = by.get(parent);
    while (up && up[2] !== "r") { chain.push(up[1]); up = by.get(up[3]); }
    const kind = KIND[t] ?? "other";
    const label = [name, ...chain].join(", ");
    // Cities and provinces first for short queries; barangays when the query names one.
    return { place: { code, name, kind, label }, tokens: words(label), rank: kind === "city" ? 0 : kind === "municipality" ? 1 : kind === "province" ? 2 : 3 };
  });
  return index;
}
export function searchPlaces(q: string, limit = 10): Place[] {
  const want = words(q); if (!want.length) return [];
  const hits = load().filter((x) => want.every((w) => x.tokens.some((t) => t.startsWith(w))));
  const first = words(q)[0]!;
  hits.sort((a, b) => Number(!words(b.place.name)[0]?.startsWith(first)) - Number(!words(a.place.name)[0]?.startsWith(first)) || a.rank - b.rank || a.place.label.length - b.place.label.length);
  return hits.slice(0, Math.min(limit, 25)).map((x) => x.place);
}
export function placeByCode(code: string): Place | null { return load().find((x) => x.place.code === code)?.place ?? null; }
