import { describe, expect, it } from "vitest";
import { generatePersonKey, keyIdFor, signChallenge, validate, verifyChallenge } from "../src/index.js";

describe("a person's own key", () => {
  it("proves a phone is the person, bound to one challenge, person and server", async () => {
    const k = await generatePersonKey();
    const sig = signChallenge("c-123", "Person/mia", "https://bix.dasig.org", k.privateKey);
    expect(verifyChallenge("c-123", "Person/mia", "https://bix.dasig.org", sig, k.publicKey)).toBe(true);
    expect(verifyChallenge("c-124", "Person/mia", "https://bix.dasig.org", sig, k.publicKey)).toBe(false); // replayed challenge
    expect(verifyChallenge("c-123", "Person/ana", "https://bix.dasig.org", sig, k.publicKey)).toBe(false); // someone else
    expect(verifyChallenge("c-123", "Person/mia", "https://evil.example", sig, k.publicKey)).toBe(false); // another server
    const other = await generatePersonKey();
    expect(verifyChallenge("c-123", "Person/mia", "https://bix.dasig.org", sig, other.publicKey)).toBe(false);
  });
  it("is listed on the Person record and validates against BIX", async () => {
    const k = await generatePersonKey();
    const person = { resourceType: "Person", id: "00000000-0000-4000-8000-000000000001", meta: { version: 1 }, name: { text: "Mia", use: "nickname" },
      publicKey: [{ kid: keyIdFor(k.publicKey), alg: "Ed25519", key: k.publicKey, created: "2026-10-30T00:00:00Z", status: "active" }] };
    expect(keyIdFor(k.publicKey)).toMatch(/^[0-9a-f]{16}$/);
    expect(validate(person as never).valid).toBe(true);
    expect(validate({ ...person, publicKey: [{ ...person.publicKey[0], key: "not-hex" }] } as never).valid).toBe(false);
  });
});
