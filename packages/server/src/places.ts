/**
 * Philippine places by PSGC code, for picking where a group or event is (data/psgc.json; credits in data/PSGC_NOTICE.md).
 * Loaded on first use. Search matches every word as a prefix of the place's name or its parents' ("lahug cebu").
 */
export type Place = { code: string; name: string; kind: "region" | "province" | "city" | "municipality" | "submunicipality" | "barangay" | "other"; label: string };
const KIND: Record<string, Place["kind"]> = { r: "region", p: "province", c: "city", m: "municipality", s: "submunicipality", b: "barangay" };
const FILLER = new Set(["brgy", "bgy", "barangay", "city", "of", "the", "municipality", "province", "poblacion"]);
const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9ñ ]+/g, " ").split(/\s+/).filter((w) => w && !FILLER.has(w));

export type PsgcData = { version: string; places: [string, string, string, string][] };
type Index = { place: Place; tokens: string[]; rank: number }[];
/** Build a searchable list from data/psgc.json (the Node server reads the file; phones never load it). */
export function placesIndex(d: PsgcData) {
  const index = buildIndex(d);
  return { version: d.version, search: (q: string, limit = 10) => searchPlaces(index, q, limit), byCode: (code: string) => index.find((x) => x.place.code === code)?.place ?? null };
}
function buildIndex(d: PsgcData): Index {
  const by = new Map(d.places.map((p) => [p[0], p]));
  return d.places.filter((p) => p[2] !== "r").map(([code, name, t, parent]) => {
    const chain: string[] = []; let up = by.get(parent);
    while (up && up[2] !== "r") { chain.push(up[1]); up = by.get(up[3]); }
    const kind = KIND[t] ?? "other";
    const label = [name, ...chain].join(", ");
    // Cities and provinces first for short queries; barangays when the query names one.
    return { place: { code, name, kind, label }, tokens: words(label), rank: kind === "city" ? 0 : kind === "municipality" ? 1 : kind === "province" ? 2 : 3 };
  });
}
function searchPlaces(index: Index, q: string, limit: number): Place[] {
  const want = words(q); if (!want.length) return [];
  const hits = index.filter((x) => want.every((w) => x.tokens.some((t) => t.startsWith(w))));
  const first = words(q)[0]!;
  hits.sort((a, b) => Number(!words(b.place.name)[0]?.startsWith(first)) - Number(!words(a.place.name)[0]?.startsWith(first)) || a.rank - b.rank || a.place.label.length - b.place.label.length);
  return hits.slice(0, Math.min(limit, 25)).map((x) => x.place);
}
