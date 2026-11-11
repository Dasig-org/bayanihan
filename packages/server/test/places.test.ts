import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { placesIndex } from "../src/places.js";

const pl = placesIndex(JSON.parse(readFileSync(new URL("../data/psgc.json", import.meta.url), "utf8")));
describe("Philippine places (PSGC)", () => {
  it("finds a barangay by name and its city, with its code and full label", () => {
    const r = pl.search("lahug cebu");
    expect(r[0]).toMatchObject({ code: "0730600041", name: "Lahug", kind: "barangay" });
    expect(r[0]!.label).toContain("City of Cebu");
  });
  it("puts cities first for a short query, and ignores words like Brgy and City", () => {
    expect(pl.search("cebu")[0]!.kind).toBe("city");
    expect(pl.search("brgy lahug")[0]!.name).toBe("Lahug");
  });
  it("looks a place up by its code", () => { expect(pl.byCode("0730600041")?.name).toBe("Lahug"); });
});
