import { describe, expect, it } from "vitest";
import { applyChange, declineSuggestion, suggestionStats, wasDeclined, type BixResource, type Context } from "../src/index.js";

/** BIX "Suggestions and their answers" (2026-11-14). */
const don = { reference: "Person/don" };
const ctx = (over: Partial<Context> = {}): Context => ({ actor: { type: "person", person: don }, permissions: ["task.assign"], now: "2026-11-14T03:00:00Z", newId: () => crypto.randomUUID(), ...over });
const task: BixResource = { resourceType: "Task", id: "11111111-1111-4111-8111-111111111111", meta: { version: 1 }, intent: "plan", status: "ready", title: "Get the barangay permit", owner: { reference: "Team/logistics" }, practice: { reference: "Practice/permit" } };

describe("suggestions and their answers", () => {
  it("accepting records the person and the model that suggested it", () => {
    const r = applyChange(null, task, ctx({ assistedBy: { type: "model", model: { name: "Bayani-1-1B", version: "1", question: "applies", confidence: 0.91 } } }));
    expect(r.ok).toBe(true);
    const agents = (r as any).provenance.agent;
    expect(agents[0]).toEqual({ type: "author", who: don });
    expect(agents[1]).toMatchObject({ type: "model", model: { question: "applies", confidence: 0.91 }, onBehalfOf: don });
  });
  it("Not this time is a declined proposal; the same suggestion isn't offered again", () => {
    const d = declineSuggestion({ id: "c1", target: { reference: "Initiative/run" }, basedOn: 1, organization: { reference: "Organization/club" }, practice: { reference: "Practice/permit" }, question: "applies", title: "Get the barangay permit" });
    expect(d.status).toBe("declined");
    expect(wasDeclined([d], "Initiative/run", "Practice/permit")).toBe(true);
    expect(wasDeclined([d], "Initiative/run", "Practice/bibs")).toBe(false);
    expect(wasDeclined([d], "Initiative/other", "Practice/permit")).toBe(false);
  });
  it("the measure counts used, edited and declined per question, and can ignore the placeholder", () => {
    const prov = (q: string, edited = false, version = "1"): BixResource => ({ resourceType: "Provenance", id: crypto.randomUUID(), meta: { version: 1 }, occurredAt: "2026-11-14T03:00:00Z",
      agent: [{ type: "author", who: don }, { type: "model", model: { name: "Bayani-1-1B", version, question: q, edited }, onBehalfOf: don }] });
    const d = { ...declineSuggestion({ id: "c2", target: { reference: "Initiative/run" }, basedOn: 1, organization: { reference: "Organization/club" }, question: "applies" }), meta: { version: 1, lastUpdated: "2026-11-14T03:00:00Z" } };
    const st = suggestionStats([prov("applies"), prov("applies", true), prov("which-team"), prov("applies", false, "0.0-placeholder")], [d], undefined, ["0.0-placeholder"]);
    expect(st["applies"]).toEqual({ used: 1, edited: 1, declined: 1 });
    expect(st["which-team"]).toEqual({ used: 1, edited: 0, declined: 0 });
  });
});
