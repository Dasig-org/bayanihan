import { describe, expect, it } from "vitest";
import { validate, resourceTypes, canTransition } from "../src/index.js";

const meta = { version: 1 };
const id = "7b1e2c4a-9f1d-4c2e-8a3b-1d77e0c3a41d";

describe("schemas load", () => {
  it("knows every v0.1 resource type", () => {
    for (const t of ["Person", "Organization", "Team", "Task", "Decision", "Goal", "Bundle", "Signature".replace("Signature", "Provenance")]) {
      expect(resourceTypes).toContain(t);
    }
  });
});

describe("validate", () => {
  it("accepts a nickname-only Person", () => {
    expect(validate({ resourceType: "Person", id, meta, name: { text: "Mia", use: "nickname" } }).valid).toBe(true);
  });
  it("accepts a LU team with a volunteer participant", () => {
    const team = {
      resourceType: "Team", id, meta, name: "Communications",
      organization: { reference: "Organization/lahug-runners" }, initiative: { reference: "Initiative/lahug-run-2027" },
      kind: "initiative", access: "initiative",
      participant: [
        { person: { reference: "Person/don" }, role: "lead", status: "active" },
        { person: { reference: "Person/jun" }, role: "volunteer", status: "active" },
      ],
    };
    expect(validate(team)).toEqual({ valid: true, errors: [] });
  });
  it("accepts a task with helpers, a gate dependency, a checklist and reference files", () => {
    const task = {
      resourceType: "Task", id, meta, intent: "plan", status: "accepted", title: "Call for speakers",
      owner: { reference: "Team/communications" }, dependsOn: [{ reference: "Task/central-approves-venue" }],
      participant: [{ person: { reference: "Person/don" }, role: "owner", status: "active" }, { person: { reference: "Person/mia" }, role: "helper", status: "active" }],
      checklist: [{ text: "Reuse last year's topics", done: true }], audience: "team",
      attachment: [{ contentType: "application/pdf", url: "files/last-years-call.pdf" }],
    };
    expect(validate(task).valid).toBe(true);
  });
  it("refuses an unknown field, so modules can't add private columns (rule 15)", () => {
    const r = validate({ resourceType: "Person", id, meta, name: { text: "Mia" }, salary: 1 });
    expect(r.valid).toBe(false);
  });
  it("refuses a 'bix' namespace in codes", () => {
    const r = validate({ resourceType: "Role", id, meta, person: { reference: "Person/m" }, organization: { reference: "Organization/o" }, status: "active", code: { system: "bix", code: "member" } });
    expect(r.valid).toBe(false);
  });
  it("refuses an unknown resource type instead of guessing", () => {
    expect(validate({ resourceType: "Patient", id, meta }).valid).toBe(false);
  });
});

describe("lifecycles", () => {
  it("lets a ready task be claimed or asked of someone", () => {
    expect(canTransition("Task", "ready", "accepted")).toBe(true);
    expect(canTransition("Task", "ready", "requested")).toBe(true);
  });
  it("lets a declined ask go back to ready", () => {
    expect(canTransition("Task", "requested", "ready")).toBe(true);
  });
  it("never reopens a completed task", () => {
    expect(canTransition("Task", "completed", "ready")).toBe(false);
  });
  it("closes a vote before deciding it", () => {
    expect(canTransition("Decision", "open", "decided")).toBe(false);
    expect(canTransition("Decision", "closed", "decided")).toBe(true);
  });
});
