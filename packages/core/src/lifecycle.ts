/** Allowed state changes, per the BIX v0.1 "Lifecycles" section. Anything not listed is refused. */
type Graph = Record<string, string[]>;

export const lifecycles: Record<string, { field: string; graph: Graph }> = {
  Task: {
    field: "status",
    graph: {
      draft: ["ready", "cancelled"],
      ready: ["accepted", "requested", "cancelled", "on-hold"],
      requested: ["accepted", "ready", "cancelled"],
      accepted: ["in-progress", "completed", "ready", "cancelled", "on-hold"],
      "in-progress": ["completed", "failed", "ready", "on-hold", "cancelled"],
      "on-hold": ["ready", "accepted", "in-progress", "cancelled"],
      completed: [],
      failed: [],
      cancelled: [],
    },
  },
  Need: { field: "status", graph: { draft: ["open", "cancelled"], open: ["partially-met", "met", "cancelled"], "partially-met": ["met", "open", "cancelled"], met: ["partially-met"], cancelled: [] } },
  Offer: { field: "status", graph: { draft: ["available", "withdrawn"], available: ["matched", "expired", "withdrawn"], matched: ["fulfilled", "available", "withdrawn"], fulfilled: [], expired: [], withdrawn: [] } },
  Initiative: { field: "status", graph: { draft: ["planned", "cancelled"], planned: ["active", "cancelled"], active: ["completed", "cancelled"], completed: [], cancelled: [] } },
  Role: { field: "status", graph: { requested: ["active", "ended"], active: ["ended"], ended: [] } },
  Report: { field: "status", graph: { owed: ["in-preparation", "cancelled"], "in-preparation": ["submitted", "cancelled"], submitted: ["acknowledged", "returned"], returned: ["in-preparation"], acknowledged: [], cancelled: [] } },
  Decision: { field: "status", graph: { draft: ["open", "cancelled"], open: ["closed", "cancelled"], closed: ["decided", "no-quorum"], decided: [], "no-quorum": [], cancelled: [] } },
  TaskDefinition: { field: "status", graph: { draft: ["active"], active: ["retired"], retired: [] } },
  ShareLink: { field: "status", graph: { active: ["revoked"], revoked: [] } },
  Consent: { field: "status", graph: { active: ["withdrawn"], withdrawn: ["active"] } },
  // BIX "Proposed edits and assistance" (2026-11-11). `outdated` is set by rule when the target moves past `basedOn`.
  ChangeProposal: { field: "status", graph: { draft: ["accepted", "declined", "withdrawn", "outdated"], accepted: [], declined: [], withdrawn: [], outdated: [] } },
};

export function canTransition(resourceType: string, from: string, to: string): boolean {
  if (from === to) return true;
  const lc = lifecycles[resourceType];
  if (!lc) return true; // types without a lifecycle have no state rule
  return (lc.graph[from] ?? []).includes(to);
}
