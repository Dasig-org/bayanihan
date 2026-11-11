import { describe, expect, it } from "vitest";
import { searchPlaces, placeByCode } from "../src/places.js";

describe("Philippine places (PSGC)", () => {
  it("finds a barangay by name and its city, with its code and full label", () => {
    const r = searchPlaces("lahug cebu");
    expect(r[0]).toMatchObject({ code: "0730600041", name: "Lahug", kind: "barangay" });
    expect(r[0]!.label).toContain("City of Cebu");
  });
  it("puts cities first for a short query, and ignores words like Brgy and City", () => {
    expect(searchPlaces("cebu")[0]!.kind).toBe("city");
    expect(searchPlaces("brgy lahug")[0]!.name).toBe("Lahug");
  });
  it("looks a place up by its code", () => { expect(placeByCode("0730600041")?.name).toBe("Lahug"); });
});
